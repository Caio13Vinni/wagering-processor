# Arquitetura — decisões, trade-offs e limitações

## Visão geral

```
HTTP --> WalletController / WageringController --+
                                                 +--> SubmitWagerTransactionUseCase
SQS --> SqsConsumer (inbox) ---------------------+         |
                                                          v
                               +- wallets (saldo materializado, versionado, CHECK balance>=0)
                               +- wallet_ledger (imutável: append-only por TRIGGER)
                  PostgreSQL ---+- wager_transactions (idempotência, status machine, FKs deferrables)
                               +- inbox_messages (dedup por entrega)
                               +- outbox_messages (eventos, atômicos c/ o commit)
                                                          |
                               OutboxPublisherWorker <----+
                                          | (cron 5s, claim atômico SKIP LOCKED)
                                          v
                               wager-events.fifo
```

## Dinheiro

- `Money` é value object imutável sobre `decimal.js`, serializado como string decimal
  escala 2 (`{ "amount": "25.00", "currency": "BRL" }`).
- Nenhum `number`/`float` em nenhuma camada; o domínio não conhece tipos monetários
  do ORM (a entity guarda `numeric(19,2)` como string e reidrata).
- Moeda única assumida (BRL) por escopo; modelo multi-moeda com validação de conflito
  (`CURRENCY_MISMATCH`).

## Unidade de concorrência e locks

A unidade de concorrência é a **wallet**. Três camadas:

1. **Lock pessimista** `SELECT ... FOR UPDATE` por transação — wallets diferentes não
   se bloqueiam (sem lock global).
2. **Optimistic como segunda barreira**: `UPDATE wallets ... WHERE id = ? AND version = ?`
   → `updated = 0` lança `CONCURRENT_MODIFICATION`.
3. **Constraints do schema**: `CHECK (balance >= 0)` e índices — a invariante vive no banco.

Cenário validado: saldo 100, duas apostas de 80 simultâneas → 1 PROCESSED, 1 REJECTED,
saldo 20, um lançamento. 50× paralelo da mesma aposta → 1 débito, 49 replays.

## Idempotência (a constraint é a fonte final)

Três camadas, da otimização à garantia:

1. **Broker** (`MessageDeduplicationId`, FIFO): otimização. Detalhe: a janela SQS é 5 min
   e descarta silenciosamente mesmo dedup-id com body diferente — nunca é a garantia.
2. **Inbox persistente** (`inbox_messages`, unique `(consumer_name, message_id)`):
   dedup por *entrega*, no mesmo commit. `INSERT ... ON CONFLICT DO NOTHING RETURNING`.
3. **Idempotency-key** (`wager_transactions.idempotency_key` unique + `payload_hash`):
   mesma key + payload divergente = **conflito (409)**, nunca replay.

**Corrida de idempotência:** a unique constraint decide quem venceu; a perdedora trata
o `23505` como caminho feliz, com três desfechos distintos: replay (hash igual, devolve
`resulting_balance` original — regra 7 — sem lock), 409 real (hash difere), ou 503
transitório (winner não visível após retry — nunca mentir 409 pra redelivery). A
re-leitura ocorre em **fork novo** (a transação abortada não executa mais SQL).

## Transacionalidade e outbox

Wallet + ledger + transação + inbox + outbox no **mesmo commit**. Eventos nunca
publicados antes do commit. O publisher (cron 5s) usa **claim atômico**:

```sql
UPDATE outbox_messages SET lease_owner = ?, leased_until = now() + interval '30 seconds'
WHERE id IN (SELECT id ... WHERE published_at IS NULL AND (lease_owner IS NULL OR leased_until < now())
             ORDER BY occurred_at LIMIT 10 FOR UPDATE SKIP LOCKED)
RETURNING ...
```

Um único statement segura os locks até o fim — instâncias concorrentes nunca pegam o
mesmo lote (sem depender do dedup do broker). Crash após o claim é recuperado pelo
`leased_until` expirando. Falhas de publish usam backoff exponencial com teto e
**esgotamento** (após 8 tentativas o evento é estacionado, auditável, sai do ciclo).

Ledger é append-only: **trigger bloqueia UPDATE/DELETE**, `UNIQUE(transaction_id)`
garante ≤ 1 lançamento por transação; `balance_before ± amount = balance_after` é
verificado. REJECTED e LOSS não geram lançamento.

## Referências fora de ordem (PENDING_REFERENCE)

REFUND/ROLLBACK sem referência existente/PROCESSED persiste como `PENDING_REFERENCE`
(sem mover saldo) e é reprocessado por worker (cron 10s). Backoff exponencial de 5s
(teto 15min); após 10 tentativas → `REJECTED / REFERENCE_NOT_FOUND` com evento.
**Referência terminal (REJECTED/FAILED) é rejeitada imediatamente** — não espera backoff.

A reversão única é garantida em duas camadas: lock pessimista da wallet antes da
checagem + **índice único parcial** `(provider_id, reference_external_transaction_id, kind)
WHERE status='PROCESSED'` — a race entre REFUND direto e reprocessamento do worker é
resolvida pelo schema.

## Schema — garantias no banco (restr. 9)

- `wallets`: `UNIQUE(player_id, currency)`, `CHECK (balance >= 0)`
- `wallet_ledger`: `UNIQUE(transaction_id)`, CHECKs de direção/valor, **trigger append-only**
- `wager_transactions`: uniques de idempotência e provider+external, `status varchar(32)`
  (PENDING_REFERENCE tem 17 chars — bug real encontrado), FKs **deferrables**
- `inbox_messages`: unique `(consumer_name, message_id)`
- índices parciais dos workers (pending-reference, outbox pendente, reversão única)

**FKs DEFERRABLE INITIALLY DEFERRED:** o MikroORM insere o batch em lote e não conhece
a ordem topológica de FKs declaradas sem relations — com deferrable, o Postgres valida
no COMMIT, ponto em que a UoW inteira já é consistente. (Bug real: insert do ledger
precedendo o da wallet.)

## MikroORM e Bun

`@mikro-orm/nestjs` descartado: incompatível com Bun (dual-package — `getORMClass is
not a function`). ORM 100% MikroORM; init manual em `src/config/orm.ts` + provider DI.
`em.transactional()` cria contexto isolado por chamada — validado sob 50 chamadas
concorrentes.

**Bug encontrado em carga real (e corrigido):** entidades criadas com `this.em.create()`
ficavam NEW no Unit of Work do fork singleton e eram re-inseridas (23505) a cada flush
posterior — mascarado como corrida de idempotência. Correção: entidades são criadas
apenas no contexto transacional (`em.create` do callback). As unique constraints
funcionaram como última linha de defesa durante todo o diagnóstico.

## SQS — classificação de erros

- **Negócio** (REJECTED, conflito): terminal → ack (resultado persistido e auditável).
- **Transitório**: não deleta — visibility expira; redrive policy (5 receives) → DLQ.
- **Permanente** (malformado): sem ack; esgota as tentativas e o redrive manda pra DLQ.
- **SIGTERM**: para o loop; mensagens em voo têm visibility zerada em batch.

## Logs, métricas e níveis

- `INFO`: eventos esperados (processado, replay, duplicata). A taxa de duplicatas é
  métrica, não volume de log.
- `WARN`: degradado recuperável (retry de outbox, reprocessamento falho).
- `ERROR`: terminal, malformado prestes a ir pra DLQ.
- Logs estruturados com `correlationId`/`messageId`/`walletId`/`providerId`; erros são
  logados como nome/código (nunca `String(e)` — vaza SQL). 500 não devolve message cru.
- Métricas em memória em `GET /metrics`: transações por status/kind, duplicatas,
  replays, outbox published/failed, divergências de reconciliação.

## Autenticação (seção 2 — sem pontuação)

Ponto de extensão concreto e validado: `JwtAuthGuard` verifica JWT RS256 via JWKS do
Keycloak (issuer + **azp** — o `aud` de access tokens Keycloak é `account`; `azp` é o
padrão correto pra client público). Ativado por `AUTH_ENABLED=true` (default false).
Realm `jungle` auto-importado pelo compose. Health e metrics abertos por requisito.

## Pegadinhas operacionais documentadas

- LocalStack isola filas por região — tudo (`us-east-1`) inclusive CLI.
- `docker compose up -d --wait` antes de qualquer comando que dependa de PG/SQS.
- Volume de dados no serviço **postgres** (não no sqs — erro real cometido).
- Dedup do SQS descarta silenciosamente na janela de 5min.
- Migrations consolidadas: schema inicial + hardening em migration única.

## Revisão técnica — achados e correções

O projeto passou por revisão externa. Bugs reais encontrados e **corrigidos**:

1. Claim do outbox não era atômico (SKIP LOCKED fora de transação) → claim em um
   statement com lease + reclaim.
2. Referência REJECTED pendurava 45min como PENDING_REFERENCE → rejeição imediata.
3. Race no reprocess (referência já revertida) → ordem de locks + índice único parcial.
4. Sem enforcement de imutabilidade no schema → trigger append-only.
5. Outbox retentava pra sempre → esgotamento com park auditável.
6. 500 com message cru / logs com SQL → sanitização.
7. Idempotency-Key e amount sem limites → 400 explícito.

## Limitações conhecidas

- Autenticação desligada por default (decisão de escopo; guard pronto).
- Métricas em memória por instância (evolução: Prometheus/OpenTelemetry).
- Domínio rico (factories/transitions) validado em testes; o caminho quente opera
  sobre entities do ORM de propósito (Unit of Work transacional) — `applyMovement`
  em entities seria a evolução natural.
- REFUND + ROLLBACK da mesma BET é permitido pelo enunciado ("pelo mesmo tipo"); o
  provedor deve usar ROLLBACK de REFUND para desfazer um refund.
