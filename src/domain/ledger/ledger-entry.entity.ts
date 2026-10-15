import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'wallet_ledger' })
@Unique({ properties: ['transactionId'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid', index: true })
  walletId!: string;

  /** Garante ≤ 1 lançamento por transação financeira. */
  @Property({ type: 'uuid' })
  transactionId!: string;

  // 'DEBIT' | 'CREDIT'
  @Property({ type: 'char', length: 6 })
  direction!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  amount!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}