import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['idempotencyKey'] })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ length: 64 })
  @Index()
  providerId!: string;

  @Property({ length: 128 })
  externalTransactionId!: string;

  /** Fonte da verdade da idempotência. */
  @Property({ length: 255 })
  idempotencyKey!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid', index: true })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 128 })
  roundId!: string;

  @Property({ length: 128 })
  gameId!: string;

  @Property({ length: 16 })
  kind!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  amount!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  /** Id no provedor da transação referenciada (não o id interno). */
  @Property({ length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ length: 16, index: true })
  status!: string;

  @Property({ length: 48, nullable: true })
  failureCode?: string;

  @Property({ type: 'integer', nullable: true })
  attempts?: number = 0;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date;
}