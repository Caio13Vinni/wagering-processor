import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../domain/wallet/wallet.entity';
import { WagerTransactionEntity } from '../domain/transaction/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../domain/ledger/ledger-entry.entity';
import { OutboxMessageEntity } from '../domain/outbox/outbox-message.entity';
import { WalletBalanceChanged } from '../domain/outbox/events';
import { Money } from '../domain/money/money';
import { LedgerDirection } from '../domain/ledger/ledger-entry';

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: {
    playerId: string;
    initialBalance: { amount: string; currency: string };
  }): Promise<{ walletId: string }> {
    const money = Money.from(input.initialBalance);

    return this.em.transactional(async (em) => {
      const exists = await em.findOne(WalletEntity, {
        playerId: input.playerId,
        currency: money.currency,
      });
      if (exists) {
        throw new WalletAlreadyExistsError(input.playerId, money.currency);
      }

      const now = new Date();
      const wallet = em.create(WalletEntity, {
        id: randomUUID(),
        playerId: input.playerId,
        currency: money.currency,
        balance: money.toJSON().amount,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      em.persist(wallet);

      if (!money.isZero()) {
        const transactionId = randomUUID();
        const correlationId = randomUUID();

        em.persist(em.create(WagerTransactionEntity, {
          id: transactionId,
          providerId: 'internal',
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `internal:opening:${wallet.id}`,
          payloadHash: 'internal',
          walletId: wallet.id,
          playerId: input.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: 'OPENING',
          amount: money.toJSON().amount,
          currency: money.currency,
          status: 'PROCESSED',
          createdAt: now,
          processedAt: now,
        }));

        em.persist(em.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId,
          direction: LedgerDirection.Credit,
          amount: money.toJSON().amount,
          currency: money.currency,
          balanceBefore: '0.00',
          balanceAfter: money.toJSON().amount,
          createdAt: now,
        }));

        em.persist(OutboxMessageEntity.enqueue(WalletBalanceChanged.from({
          correlationId,
          walletId: wallet.id,
          transactionId,
          direction: LedgerDirection.Credit,
          money: money.toJSON(),
          balanceBefore: { amount: '0.00', currency: money.currency },
          balanceAfter: money.toJSON(),
          walletVersion: 1,
        })));
      }

      return { walletId: wallet.id };
    });
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`wallet already exists for player ${playerId} and currency ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}