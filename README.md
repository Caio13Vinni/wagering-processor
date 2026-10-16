# Wagering Processor — Jungle Gaming Technical Challenge

Serviço financeiro distribuído que processa transações de apostas (BET, WIN,
LOSS, REFUND, ROLLBACK) vindas de múltiplos provedores, via HTTP e SQS,
com garantias de idempotência, concorrência e consistência saldo <-> ledger.

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript (strict) |
| Framework | NestJS |
| ORM | MikroORM (inicialização manual — ver ARCHITECTURE.md) |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS via LocalStack |
| Orquestração | Docker Compose |
| Migrations | MikroORM Migrator (versionadas, reversíveis) |

## Pré-requisitos

- Bun 1.x
- Docker + Docker Compose
- aws-cli (apenas para comandos manuais de fila — opcional)

## Setup

```bash
git clone <repo> && cd wagering-processor
bun install

# 1. sobe PostgreSQL e LocalStack (aguarda healthy)
docker compose up -d --wait postgres sqs

# 2. cria as filas (idempotente — pode rodar quantas vezes quiser)
bun run setup:queues

# 3. aplica as migrations (schema completo + ajustes)
bun run migration:up

# 4. sobe a API (porta 3000) — consumer SQS e workers entram junto
bun run start
```

Alternativa full-container (app também em container):

```bash
docker compose up -d --wait
```

## Health checks (sem autenticação)

```bash
curl localhost:3000/health/live    # processo vivo
curl localhost:3000/health/ready   # PostgreSQL + SQS alcançáveis
```

## API — exemplos rápidos

```bash
# criar wallet (repetir = 409)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}'

# submeter transação (Idempotency-Key obrigatório)
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<id-da-wallet>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'

# consultas
curl localhost:3000/wallets/<walletId>
curl "localhost:3000/wallets/<walletId>/ledger?limit=50"
curl localhost:3000/wagering/transactions/<transactionId>
curl localhost:3000/providers/<providerId>/wagering/transactions/<externalTransactionId>

# reconciliação (saldo materializado vs Soma ledger — nunca corrige silenciosamente)
curl -X POST localhost:3000/wallets/<walletId>/reconciliation
```

**Mapeamento de status HTTP:** 201 processado | 200 replay | 202 pendente |
400 payload inválido | 409 conflito (idempotência/wallet duplicada) |
422 rejeitado por regra de negócio | 503 falha transitória de infraestrutura.

## Filas

| Fila | Função |
|---|---|
| `wager-transactions.fifo` | entrada de operações dos provedores |
| `wager-transactions-dlq.fifo` | redrive automático após 5 receives sem ack |
| `wager-events.fifo` | eventos de integração publicados pelo outbox |

## Scripts úteis

```bash
bun run setup:queues      # cria/atualiza filas (idempotente)
bun run migration:up      # aplica migrations pendentes
bun run migration:create  # gera migration a partir do diff entities<->snapshot
bun scripts/test-race.ts  # teste de corrida de idempotência (2 e 50 concorrentes)
```

## Autenticação

Não implementada por escopo (não pontua no desafio). Mensagens de fila são
canal interno confiável; a identidade do provedor na mensagem é validada por
regras de domínio (escopo de referência, unicidade provider+external, etc.).
O ponto de extensão são os controllers (`WalletController`, `WageringController`)
— um guard de JWT/OIDC (Keycloak, Zitadel) plugaria ali sem tocar no domínio.
Health checks ficam abertos por requisito.

Veja `ARCHITECTURE.md` para decisões, trade-offs e limitações.
