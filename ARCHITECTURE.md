# Arquitetura — decisões, trade-offs e limitações

## Visão geral

```
HTTP --> WalletController / WageringController --+
                                                 +--> SubmitWagerTransactionUseCase
SQS --> SqsConsumer (inbox) ---------------------+         |
                                                          v
                               +- wallets (saldo materializado, versionado)
                               +- wallet_ledger (imutável, append-only)
                  PostgreSQL ---+- wager_transactions (status machine + idempotência)
                               +- inbox_messages (dedup por entrega)
                               +- outbox_messages (eventos, atômicos c/ o commit)
                                                          |
                               OutboxPublisherWorker <----+
                                          | (cron 5s, SKIP LOCKED)
                                          v
                               wager-events.fifo
```

## Dinheiro

- `Money` é um value object imutável sobre `decimal.js`, serializado como
  string decimal com escala 2 (`{ "amount": "25.00", "currency": "BRL" }`).
- Nenhum `number`/`float` em nenhuma camada; o domínio não conhece tipos
  monetários do ORM (o entity guarda `numeric(19,2)` como string e reidrata).
- Moeda única assumida (BRL) por escopo, mas o modelo é multi-moeda e
  conflitos de moeda são validados (rejeição com `CURRENCY_MISMATCH`).

## Unidade de concorrência e locks

A unidade de concorrência é a **wallet**. Estratégia em camadas:

1. **Lock pessimista** `SELECT ... FOR UPDATE` na wallet por transação —
   duas apostas disputando o mesmo saldo serializam; wallets diferentes
   não se bloqueiam (sem lock global).
2. **Optimistic locking como segunda barreira**: o `UPDATE wallets ...
   WHERE id = ? AND version = ?` condiciona o update à versão lida sob lock;
   `updated = 0` -> `CONCURRENT_MODIFICATION` (erro de programação, não de
   negócio).
3. **Constraint de schema**: `CHECK (balance >= 0)` — mesmo alguém executando
   SQL manual não consegue saldo negativo. A invariante vive no banco, não
   só no código.

Cenário validado: saldo 100, duas apostas de 80 simultâneas -> exatamente uma
PROCESSED, outra REJECTED `INSUFFICIENT_BALANCE`, saldo 20, um lançamento no
ledger. Teste de 50 submissões paralelas da mesma aposta -> 1 débito, 49 replays.

## Idempotência (a constraint é a fonte final)

Três camadas, da otimização à garantia:

1. **Broker** (`MessageDeduplicationId`, ordering FIFO): otimização apenas.
   Detalhe operacional: a janela de dedup do SQS é de 5 min e **descarta
   silenciosamente** mensagens com mesmo dedup-id e body diferente — por isso
   nunca é garantia (restr. 3 do desafio).
2. **Inbox persistente** (`inbox_messages`, unique `(consumer_name, message_id)`):
   dedup por *entrega*, no mesmo commit do processamento. `INSERT ... ON
   CONFLICT DO NOTHING RETURNING` — atômico, sem check-then-insert.
3. **Idempotency-key** (`wager_transactions.idempotency_key` unique +
   `payload_hash`): dedup por *operação de negócio*. A mesma key com payload
   divergente é **conflito** (`409`), nunca replay.

**Corrida de idempotência:** duas requisições com a mesma key passam pela
checagem em memória simultaneamente; a unique constraint decide quem venceu.
A transação perdedora aborta e o código trata a violação (`23505`) como caminho
feliz, com três desfechos semanticamente distintos:

- winner visível + hash igual -> **replay** (200), retornando o
  `resulting_balance` **observado no processamento** (regra 7), sem lock na
  wallet;
- winner visível + hash diferente -> **409** (conflito real);
- winner não visível após retry com backoff -> **erro transitório** (`503` em
  HTTP, visibility expira em SQS). Nunca mentir `409` para um redelivery
  legítimo: `409` mata reenvios at-least-once.

Re-leitura em **fork novo**: a transação abortada não pode mais executar SQL
(`current transaction is aborted`).

## Transacionalidade e outbox

Wallet + ledger + transação + inbox + outbox no **mesmo commit**.
Eventos nunca são publicados antes do commit (restr. 4). O
`OutboxPublisherWorker` (cron 5s) usa `SELECT ... FOR UPDATE SKIP LOCKED` para
múltiplas instâncias pegarem lotes disjuntos; `markPublished` é condicional
(`WHERE published_at IS NULL`); publish duplicado é seguro para o consumidor
(dedup por `eventId`). Falhas de publish usam backoff exponencial com teto.

Ledger é **append-only**: sem UPDATE/DELETE, `UNIQUE(transaction_id)` garante
<= 1 lançamento por transação, e `balance_before +/- amount = balance_after` é
verificada na factory. REJECTED e LOSS não geram lançamento.

## Referências fora de ordem (PENDING_REFERENCE)

REFUND/ROLLBACK cuja referência ainda não existe (ou não está PROCESSED) é
persistido como `PENDING_REFERENCE` — sem efeito no saldo — e reprocessado pelo
`PendingReferenceWorker` (cron 10s, `SKIP LOCKED`, lock pessimista por linha,
revalidação de status dentro da transação). Backoff exponencial de 5s com teto
de 15min; após 10 tentativas (~45min de TTL) -> `REJECTED` com código de
referência inexistente (`MissingReference`) e evento no mesmo commit.
Quando a referência aparece, a movimentação é aplicada com exatamente as
mesmas regras do fluxo principal (validações de escopo/kind/valor, saldo para
reversão com `INSUFFICIENT_BALANCE_FOR_REVERSAL` — código distinto do de aposta
sem saldo, regra 9).

Observação: REFUND/ROLLBACK exigem `referenceExternalTransactionId` na
entrada; referência a si mesmo é rejeitada (`SELF_REFERENCE`). Valor de
reversão deve ser **igual** ao da referência (`AMOUNT_MISMATCH` se divergir);
reversão parcial está fora de escopo. Uma referência não pode ser revertida
duas vezes pelo mesmo tipo (`REFERENCE_ALREADY_REVERTED`).

## MikroORM e Bun

`@mikro-orm/nestjs` foi descartado: incompatibilidade conhecida com Bun
(dual-package — o wrapper carrega `@mikro-orm/core` via `require` CJS e os
prototypes do driver divergem; erro `getORMClass is not a function`). O ORM em
si é 100% MikroORM (`@mikro-orm/core` + `@mikro-orm/postgresql`); a
inicialização é manual em `src/config/orm.ts` e o `EntityManager` entra no DI
do Nest via provider. `em.transactional()` cria um contexto transacional
isolado por chamada — validado sob 50 chamadas concorrentes sobre o mesmo EM.

O diff do `migration:create` compara entities <-> snapshot
(`migrations/.snapshot-*.json`); mudanças **só de tamanho de coluna** não são
sempre detectadas — nesse caso a migration é escrita à mão (foi o caso de
`status varchar(16) -> varchar(32)`; `PENDING_REFERENCE` tem 17 caracteres).

## SQS — classificação de erros

- **Negócio** (transação REJECTED, conflito de idempotência): terminal -> **ack**
  (o resultado está persistido e auditável).
- **Transitório** (PG/SQS indisponível, `IdempotencyRaceUnresolvedError`):
  não deleta — visibility expira -> redelivery com backoff do próprio SQS;
  `redrive policy` (maxReceiveCount=5) move para a **DLQ** automaticamente.
- **Permanente** (payload malformado): não é dado ack; as 5 tentativas esgotam
  e o redrive manda para a DLQ. (Melhoria conhecida: rotear malformados para a
  DLQ imediatamente checando `ApproximateReceiveCount` na 1ª entrega.)

**SIGTERM:** `onModuleDestroy` para o loop de receive; mensagens recebidas mas
não processadas têm visibility zerada em batch (`ChangeMessageVisibilityBatch`)
— nada de in-flight é perdido nem duplicado.

## Logs e níveis

- `INFO` — eventos de negócio **esperados** (processado, replay, rejeição por
  regra, duplicata resolvida). Duplicata é fluxo normal de entrega
  at-least-once: WARN aqui treinaria o time a ignorar WARN e poluiria
  dashboards/alertas (Datadog/Kibana). A taxa é observada por métrica, não por
  volume de log.
- `WARN` — degradado mas recuperável (retry de outbox, reprocess falho).
- `ERROR` — terminal não tratado, malformado prestes a ir pra DLQ.

Logs estruturados (JSON) com `correlationId`, `messageId`, `transactionId`,
`walletId`, `providerId`; sem payloads financeiros completos.

## Schema — garantias no banco (restr. 9 do desafio)

- `wallets`: `UNIQUE(player_id, currency)`, `CHECK (balance >= 0)`
- `wallet_ledger`: `UNIQUE(transaction_id)` (<= 1 lançamento/tx), append-only
- `wager_transactions`: `UNIQUE(idempotency_key)`,
  `UNIQUE(provider_id, external_transaction_id)`, `status varchar(32)`
- `inbox_messages`: PK/unique `(consumer_name, message_id)`
- `outbox_messages`: `WHERE published_at IS NULL` + índice em `next_attempt_at`

## Pegadinhas operacionais documentadas

- **LocalStack isola filas por região** — app, scripts e CLI devem usar a
  mesma região (`us-east-1`). CLI: `export AWS_DEFAULT_REGION=us-east-1`.
- **`docker compose up -d --wait`** antes de qualquer comando que dependa de
  PG/SQS; healthchecks já modelam isso para o serviço `app`.
- **Volume de dados no serviço certo** — `pgdata` montado em `postgres`, não
  em `sqs` (erro real cometido durante o desenvolvimento: dados sumiam a cada
  `down`).
- **Detecção de erro por string** (`QueueNameExists`) é frágil entre runtimes;
  o `upsertQueue` cobre os formatos conhecidos do LocalStack/AWS.

## Limitações conhecidas

- Autenticação não implementada (fora de escopo do desafio) — ponto de
  extensão nos controllers.
- Backoff do worker de referência e TTL (~45min) são escolhas razoáveis, não
  calculadas; um round real de jogo resolve referências em segundos.
- Métricas: contadores planejados no Lote G (transações por status,
  duplicatas, DLQ, outbox lag); hoje a observabilidade é por logs.
- `test-race.ts` cobre concorrência real, mas a suíte formal (`bun test`)
  ainda será consolidada (Lote F).
