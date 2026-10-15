import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { IntegrationEvent } from './integration-event';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ length: 64 })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime' })
  occurredAt: Date = new Date();

  @Property({ type: 'integer' })
  attempts: number = 0;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date;

  @Index()
  @Property({ length: 16, nullable: true })
  leaseOwner?: string; // permite múltiplos publishers sem corrida

  @Property({ type: 'datetime', nullable: true })
  leasedUntil?: Date;

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessageEntity {
    const message = new OutboxMessageEntity();
    message.id = event.eventId;
    message.aggregateId = event.aggregateId;
    message.eventType = event.eventType;
    message.payload = event.toJSON();
    message.occurredAt = event.occurredAt;
    message.attempts = 0;
    return message;
  }

  isPending(): boolean {
    return !this.publishedAt;
  }

  isDue(now: Date): boolean {
    if (this.publishedAt) return false;
    if (!this.nextAttemptAt) return true;
    return this.nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    this.publishedAt = at;
    this.leaseOwner = undefined;
    this.leasedUntil = undefined;
  }

  /** Backoff exponencial com jitter: 1s, 2s, 4s ... teto de 8 tentativas. */
  scheduleRetry(now: Date): void {
    this.attempts += 1;
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** (this.attempts - 1),
      60_000,
    );
    const jitter = Math.floor(Math.random() * delay * 0.1);
    this.nextAttemptAt = new Date(now.getTime() + delay + jitter);
    this.leaseOwner = undefined;
    this.leasedUntil = undefined;
  }

  get exhausted(): boolean {
    return this.attempts >= MAX_ATTEMPTS;
  }
}