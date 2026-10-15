import { Entity, PrimaryKey, Property, Unique, Check } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
@Check({ expression: 'balance >= 0' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  /** Sempre string — nunca number (regra inviolável #1). */
  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version: number = 1;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}