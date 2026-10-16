import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { orm, runId, forkEm, newPlayer, money } from './setup';
import Decimal from 'decimal.js';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import {
  SubmitWagerTransactionUseCase,
  SubmitInput,
  IdempotencyConflictError,
} from '../../src/application/submit-wager-transaction.use-case';

const em = forkEm(); // fork isolado por arquivo de teste
const playerId = newPlayer(); // player único por arquivo de teste
const createWallet = new CreateWalletUseCase(em);
const useCase = new SubmitWagerTransactionUseCase(em);

const P = `provider-${runId}`;

async function balance(): Promise<string> {
  const w = await em.getConnection().execute(
    `select balance::text as balance from wallets where id = '${walletId}'`);
  return w[0].balance;
}

function tx(n: string, over: Partial<SubmitInput> = {}): { dto: SubmitInput; key: string } {
  return {
    dto: {
      providerId: P,
      externalTransactionId: `${n}-${runId}`,
      playerId,
      walletId: '', // preenchido no beforeAll
      roundId: `round-${runId}`,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: money('10.00'),
      ...over,
    } as SubmitInput,
    key: `${P}:${n}-${runId}`,
  };
}

let walletId = '';

describe('wagering (integração real)', () => {
  test('wallet: cria com opening credit no ledger', async () => {
    const { walletId: id } = await createWallet.execute({ playerId, initialBalance: money('100.00') });
    walletId = id;
    const rows = await em.getConnection().execute(
      `select direction, amount::text as amount from wallet_ledger where wallet_id = '${id}'`);
    expect(rows.length).toBe(1);
    expect(rows[0].direction.trim()).toBe('CREDIT');
    expect(rows[0].amount).toBe('100.00');
  });

  test('wallet: duplicada é conflito', async () => {
    await expect(createWallet.execute({ playerId, initialBalance: money('1.00') }))
      .rejects.toThrow(/already exists/i);
  });

  test('BET debita; replay devolve saldo ORIGINAL (regra 7)', async () => {
    const { dto, key } = tx('bet1', { money: money('25.00') });
    dto.walletId = walletId;

    const r1 = await useCase.execute({ ...dto }, key, { channel: 'http' });
    expect(r1.status).toBe('PROCESSED');
    expect(r1.balance?.amount).toBe('75.00');
    expect(r1.idempotentReplay).toBe(false);

    // segunda BET muda o saldo atual
    const { dto: dto2, key: key2 } = tx('bet1b', { money: money('25.00') });
    dto2.walletId = walletId;
    await useCase.execute({ ...dto2 }, key2, { channel: 'http' }); // saldo atual: 50.00

    // replay da primeira DEVE responder 75.00 (observado no processamento)
    const replay = await useCase.execute({ ...dto }, key, { channel: 'http' });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.amount).toBe('75.00');
  });

  test('mesma key + payload divergente = conflito', async () => {
    const { dto, key } = tx('conflict', { money: money('10.00') });
    dto.walletId = walletId;
    await useCase.execute({ ...dto }, key, { channel: 'http' });
    await expect(
      useCase.execute({ ...dto, money: money('99.00') }, key, { channel: 'http' }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  test('saldo insuficiente: REJECTED, sem lançamento no ledger', async () => {
    const { dto, key } = tx('insuf', { money: money('99999.00') });
    dto.walletId = walletId;
    const r = await useCase.execute({ ...dto }, key, { channel: 'http' });
    expect(r.status).toBe('REJECTED');
    expect(r.failureCode).toBe('INSUFFICIENT_BALANCE');
    const rows = await em.getConnection().execute(
      `select count(*)::int as n from wallet_ledger l
        join wager_transactions t on t.id = l.transaction_id
       where t.idempotency_key = '${key}'`);
    expect(rows[0].n).toBe(0);
  });

  test('WIN credita; LOSS não move saldo', async () => {
    const before = await balance();

    const win = tx('win1', { kind: 'WIN' as const, money: money('40.00') });
    win.dto.walletId = walletId;
    const rw = await useCase.execute({ ...win.dto }, win.key, { channel: 'http' });
    expect(rw.status).toBe('PROCESSED');
    expect(rw.balance?.amount).toBe(new Decimal(before).plus('40.00').toFixed(2));

    const loss = tx('loss1', { kind: 'LOSS' as const });
    loss.dto.walletId = walletId;
    const rl = await useCase.execute({ ...loss.dto }, loss.key, { channel: 'http' });
    expect(rl.status).toBe('PROCESSED');
    // LOSS: sem efeito no saldo, sem lançamento
    expect(rl.balance?.amount).toBe(rw.balance?.amount);
  });

  test('REFUND reverte BET uma única vez', async () => {
    const bet = tx('refbet', { money: money('10.00') });
    bet.dto.walletId = walletId;
    const rb = await useCase.execute({ ...bet.dto }, bet.key, { channel: 'http' });
    const afterBet = rb.balance!.amount;

    const ref = tx('refund1', {
      kind: 'REFUND' as const, money: money('10.00'),
      referenceExternalTransactionId: bet.dto.externalTransactionId,
    });
    ref.dto.walletId = walletId;
    const rr = await useCase.execute({ ...ref.dto }, ref.key, { channel: 'http' });
    expect(rr.status).toBe('PROCESSED');
    expect(rr.balance?.amount).toBe(new Decimal(afterBet).plus('10.00').toFixed(2));

    const ref2 = tx('refund2', {
      kind: 'REFUND' as const, money: money('10.00'),
      referenceExternalTransactionId: bet.dto.externalTransactionId,
    });
    ref2.dto.walletId = walletId;
    const rr2 = await useCase.execute({ ...ref2.dto }, ref2.key, { channel: 'http' });
    expect(rr2.status).toBe('REJECTED');
    expect(rr2.failureCode).toBe('REFERENCE_ALREADY_REVERTED');
  });

  test('REFUND sem referencia e com valor divergente são rejeitados', async () => {
    const noRef = tx('norefund', { kind: 'REFUND' as const, money: money('10.00') });
    noRef.dto.walletId = walletId;
    const r1 = await useCase.execute({ ...noRef.dto }, noRef.key, { channel: 'http' });
    expect(r1.status).toBe('REJECTED');
    expect(r1.failureCode).toBe('MISSING_REFERENCE');

    const bet = tx('ambet', { money: money('10.00') });
    bet.dto.walletId = walletId;
    await useCase.execute({ ...bet.dto }, bet.key, { channel: 'http' });

    const wrongAmount = tx('wrongamt', {
      kind: 'REFUND' as const, money: money('11.00'),
      referenceExternalTransactionId: bet.dto.externalTransactionId,
    });
    wrongAmount.dto.walletId = walletId;
    const r2 = await useCase.execute({ ...wrongAmount.dto }, wrongAmount.key, { channel: 'http' });
    expect(r2.status).toBe('REJECTED');
    expect(r2.failureCode).toBe('AMOUNT_MISMATCH');
  });

  test('inbox: redelivery da MESMA mensagem não duplica efeito', async () => {
    const { dto, key } = tx('sqs1', { money: money('5.00') });
    dto.walletId = walletId;
    const source = { channel: 'sqs' as const, messageId: `msg-${runId}-1`, consumerName: 'test' };

    const r1 = await useCase.execute({ ...dto }, key, source);
    expect(r1.idempotentReplay).toBe(false);

    const r2 = await useCase.execute({ ...dto }, key, source); // mesma messageId
    expect(r2.idempotentReplay).toBe(true);

    // exatamente 1 transação persistida para a key, com exatamente 1 lançamento
    const txs = await em.getConnection().execute(
      `select id, status from wager_transactions where idempotency_key = '${key}'`);
    expect(txs.length).toBe(1);
    const entries = await em.getConnection().execute(
      `select count(*)::int as n from wallet_ledger where transaction_id = '${txs[0].id}'`);
    expect(entries[0].n).toBe(1);
  });

  test('invariante final: balance == Σ ledger', async () => {
    const rows = await em.getConnection().execute(
      `select w.balance::text as balance,
              (select coalesce(sum(case when l.direction = 'DEBIT' then -l.amount else l.amount end), 0)
                 from wallet_ledger l where l.wallet_id = w.id)::text as total
         from wallets w where w.id = '${walletId}'`);
    expect(rows[0].balance).toBe(rows[0].total);
  });
});
