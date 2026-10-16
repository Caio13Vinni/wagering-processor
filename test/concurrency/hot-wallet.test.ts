import { describe, expect, test } from 'bun:test';
import { orm, runId, forkEm, newPlayer, money } from '../integration/setup';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';

/**
 * Cenário obrigatório da seção 8 + teste 13.4.1:
 * saldo 100, duas apostas de 80 simultâneas → exatamente 1 PROCESSED,
 * 1 REJECTED por saldo insuficiente, saldo final 20, exatamente 1 débito.
 */
describe('concorrência na hot wallet (integração real, paralelismo real)', () => {
  test('duas apostas de 80 disputando saldo 100', async () => {
    const em = forkEm(); // fork isolado por teste
    const playerId = newPlayer();
    const createWallet = new CreateWalletUseCase(em);
    const useCase = new SubmitWagerTransactionUseCase(em);
    const { walletId } = await createWallet.execute({ playerId, initialBalance: money('100.00') });

    const mk = (n: string) => ({
      dto: {
        providerId: `provider-${runId}`, externalTransactionId: `hot-${n}-${runId}`,
        playerId, walletId, roundId: `round-${runId}`, gameId: 'fortune-chimp',
        kind: 'BET' as const, money: money('80.00'),
      },
      key: `provider-${runId}:hot-${n}-${runId}`,
    });

    const a = mk('a');
    const b = mk('b');
    const [ra, rb] = await Promise.all([
      useCase.execute({ ...a.dto }, a.key, { channel: 'http' }),
      useCase.execute({ ...b.dto }, b.key, { channel: 'http' }),
    ]);

    const processed = [ra, rb].filter((r) => r.status === 'PROCESSED');
    const rejected = [ra, rb].filter((r) => r.status === 'REJECTED');
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].failureCode).toBe('INSUFFICIENT_BALANCE');

    const w = await em.getConnection().execute(
      `select balance::text as balance from wallets where id = '${walletId}'`);
    expect(w[0].balance).toBe('20.00');

    const ledger = await em.getConnection().execute(
      `select count(*)::int as n from wallet_ledger
        where wallet_id = '${walletId}' and direction = 'DEBIT'`);
    expect(ledger[0].n).toBe(1); // exatamente um débito
  });

  test('50× a mesma aposta em paralelo → um único débito', async () => {
    const em = forkEm();
    const playerId = newPlayer();
    const createWallet = new CreateWalletUseCase(em);
    const useCase = new SubmitWagerTransactionUseCase(em);
    const { walletId } = await createWallet.execute({ playerId, initialBalance: money('100.00') });

    const dto = {
      providerId: `provider-${runId}`, externalTransactionId: `fifty-${runId}`,
      playerId, walletId, roundId: `round-${runId}`, gameId: 'fortune-chimp',
      kind: 'BET' as const, money: money('25.00'),
    };
    const key = `provider-${runId}:fifty-${runId}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute({ ...dto }, key, { channel: 'http' })),
    );

    const processed = results.filter((r) => r.status === 'PROCESSED' && !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);
    expect(processed.length).toBe(1);
    expect(replays.length).toBe(49);

    const w = await em.getConnection().execute(
      `select balance::text as balance from wallets where id = '${walletId}'`);
    expect(w[0].balance).toBe('75.00');

    const debits = await em.getConnection().execute(
      `select count(*)::int as n from wallet_ledger
        where wallet_id = '${walletId}' and direction = 'DEBIT'`);
    expect(debits[0].n).toBe(1);
  });
});
