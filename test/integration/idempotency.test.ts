import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/config/mikro-orm.config';
import { SubmitWagerTransactionUseCase, IdempotencyConflictError } from '../../src/application/submit-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, dbName: 'wagering_test' });
  await orm.schema.refreshDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

async function setup(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const { walletId } = await new CreateWalletUseCase(orm.em.fork()).execute({
    playerId,
    initialBalance: { amount: initial, currency: 'BRL' },
  });
  const txId = `tx-${crypto.randomUUID()}`;
  const dto: any = {
    providerId: 'provider-a', externalTransactionId: txId,
    playerId, walletId, roundId: 'r1', gameId: 'g1',
    kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  };
  return { dto, key: `provider-a:${txId}`, useCase: new SubmitWagerTransactionUseCase(orm.em.fork()) };
}

describe('idempotência', () => {
  it('processa a aposta e debita o saldo', async () => {
    const { dto, key, useCase } = await setup();
    const r = await useCase.execute(dto, key, { channel: 'http' });
    expect(r.status).toBe('PROCESSED');
    expect(r.balance?.amount).toBe('75.00');
    expect(r.idempotentReplay).toBe(false);
  });

  it('replay com mesma chave e payload não debita de novo', async () => {
    const { dto, key, useCase } = await setup();
    await useCase.execute(dto, key, { channel: 'http' });
    const replay = await useCase.execute(dto, key, { channel: 'http' });
    expect(replay.status).toBe('PROCESSED');
    expect(replay.idempotentReplay).toBe(true);

    const rows = await orm.em.fork().getConnection().execute(
      'select balance from wallets where id = ?', [dto.walletId],
    );
    expect(rows[0].balance).toBe('75.00');
  });

  it('mesma chave com payload diferente lança conflito', async () => {
    const { dto, key, useCase } = await setup();
    await useCase.execute(dto, key, { channel: 'http' });
    const other = { ...dto, money: { amount: '26.00', currency: 'BRL' } };
    await expect(
        useCase.execute(other, key, { channel: 'http' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
});

  it('rejeita aposta maior que o saldo', async () => {
    const { dto, key, useCase } = await setup('10.00');
    const r = await useCase.execute(dto, key, { channel: 'http' });
    expect(r.status).toBe('REJECTED');
    expect(r.failureCode).toBe('INSUFFICIENT_BALANCE');
  });
});