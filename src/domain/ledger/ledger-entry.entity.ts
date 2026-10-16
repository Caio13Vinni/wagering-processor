import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'wallet_ledger' })
@Unique({ properties: ['transactionId'] })
@Check({ name: 'chk_ledger_direction', expression: "direction in ('DEBIT', 'CREDIT')" })
@Check({ name: 'chk_ledger_amount', expression: 'amount > 0' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid', index: true })
  walletId!: string;

  /** Garante ≤ 1 lancamento por transacao financeira. */
  @Property({ type: 'uuid' })
  transactionId!: string;

  // 'DEBIT' | 'CREDIT' — varchar(6): char(6) paddeia 'DEBIT ' e quebra filtros SQL
  @Property({ type: 'varchar', length: 6 })
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
