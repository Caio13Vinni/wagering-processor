/**
 * scripts/test-race.ts — testa a corrida de idempotência (Bug 1) e o replay com saldo original (Bug 2)
 * Pré-requisito: docker compose up -d postgres && bun run migration:up
 */
import { Logger } from '@nestjs/common';
Logger.overrideLogger(['error']);
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/config/mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '../src/application/submit-wager-transaction.use-case';

const orm = await MikroORM.init(config);
const em = orm.em.fork();

const createWallet = new CreateWalletUseCase(em);
const useCase = new SubmitWagerTransactionUseCase(em);

const runId = Date.now().toString(36);
const playerId = randomUUID(); // player_id é uuid no schema
const { walletId } = await createWallet.execute({
  playerId,
  initialBalance: { amount: '100.00', currency: 'BRL' },
});

const basePayload = {
  providerId: `provider-${runId}`,
  playerId,
  walletId,
  roundId: `round-${runId}`,
  gameId: 'fortune-chimp',
  kind: 'BET' as const,
  money: { amount: '25.00', currency: 'BRL' },
};

function makeBet(n: number) {
  const payload = {
    ...basePayload,
    externalTransactionId: `bet-${n}-${runId}`,
  };
  return {
    payload,
    key: `provider-${runId}:bet-${n}-${runId}`,
  };
}

// ---- teste 1: corrida de 2 na mesma key + replay com saldo ORIGINAL (regra 7) ----
{
  const { payload, key } = makeBet(1);
  const submit = () => useCase.execute({ ...payload }, key, { channel: 'http' });
  const [a, b] = await Promise.all([submit(), submit()]);
  const flags = [a.idempotentReplay, b.idempotentReplay].sort().join(',');
  const ok = flags === 'false,true';
  console.log(`race-2:  ${ok ? '✅ PASS' : `❌ FAIL (${flags})`}`,
    { a: `${a.status}/replay=${a.idempotentReplay}`, b: `${b.status}/replay=${b.idempotentReplay}` });

  // regra 7: replay da bet-1 DEPOIS que ela já foi processada
  // deve responder o saldo ORIGINAL observado no processamento (75.00)
  const replay = await useCase.execute({ ...payload }, key, { channel: 'http' });
  const replayOk = replay.idempotentReplay === true && replay.balance?.amount === '75.00';
  console.log(`replay-saldo-original: ${replayOk ? '✅ PASS (75.00)' : `❌ FAIL (${JSON.stringify(replay.balance)})`}`);
  if (!replayOk) process.exitCode = 1;
}

// ---- teste 2: 50× paralelo com key NOVA (cenário da seção 13) ----
{
  const { payload, key } = makeBet(2);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => useCase.execute({ ...payload }, key, { channel: 'http' })),
  );
  const processed = results.filter((r) => r.status === 'PROCESSED' && !r.idempotentReplay).length;
  const replays = results.filter((r) => r.idempotentReplay).length;
  const failures = results.filter((r) => !r.idempotentReplay && r.status !== 'PROCESSED').length;
  const ok = processed === 1 && replays === 49 && failures === 0;
  console.log(`race-50: ${ok ? '✅ PASS (1 processed, 49 replays, 0 erros)' : `❌ FAIL (${processed} processed, ${replays} replays, ${failures} outros)`}`);
  if (!ok) process.exitCode = 1;
}

// ---- confere no banco ----
const rows = (await em.getConnection().execute(
  `select direction, count(*)::int as n from wallet_ledger where wallet_id = '${walletId}' group by direction`,
)) as Array<{ direction: string; n: number }>;
const count = (dir: string) => rows.find((r) => r.direction.trim() === dir)?.n ?? 0;

const walletRows = (await em.getConnection().execute(
  `select balance::text as balance from wallets where id = '${walletId}'`,
)) as Array<{ balance: string }>;
const balance = walletRows[0]?.balance;

const creditOk = count('CREDIT') === 1;   // opening
const debitOk = count('DEBIT') === 2;     // bet-1 + bet-2
const balanceOk = balance === '50.00';    // 100 - 25 - 25

console.log(`ledger:  ${creditOk && debitOk ? '✅ 1 CREDIT (opening) + 2 DEBIT' : `❌ ${JSON.stringify(rows)}`}`);
console.log(`saldo:   ${balanceOk ? '✅ 50.00' : `❌ ${balance}`}`);
if (!(creditOk && debitOk && balanceOk)) process.exitCode = 1;

await orm.close();
process.exit(process.exitCode ?? 0);