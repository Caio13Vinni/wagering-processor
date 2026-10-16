import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { metrics } from '../infrastructure/metrics/metrics';
import { QUEUES, createSqsClient, queueUrl } from '../infrastructure/sqs/queues';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number | null;
}

@Injectable()
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly sqs = createSqsClient();

  constructor(private readonly em: EntityManager) {}

  @Cron('*/5 * * * * *') // a cada 5s
  async publish(): Promise<void> {
    const rows = (await this.em.getConnection().execute(
      `select id, aggregate_id, payload, attempts
         from outbox_messages
        where published_at is null
          and (next_attempt_at is null or next_attempt_at <= now())
        order by occurred_at
        limit 10
        for update skip locked`, 
    )) as OutboxRow[];

    for (const row of rows) {
      try {
        await this.sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl(QUEUES.WAGER_EVENTS),
          MessageBody: JSON.stringify(row.payload),
          MessageGroupId: row.aggregate_id,
          MessageDeduplicationId: row.id,
        }));
        await this.em.getConnection().execute(
          `update outbox_messages set published_at = now() where id = ? and published_at is null`,
          [row.id],
        );
        this.logger.log({ msg: 'outbox event published', eventId: row.id });
        metrics.increment('outbox.published');
      } catch (e) {
        const attempts = (row.attempts ?? 0) + 1;
        const delayMs = Math.min(1_000 * 2 ** attempts, 60_000);
        await this.em.getConnection().execute(
          `update outbox_messages
              set attempts = ?, next_attempt_at = now() + make_interval(secs => ?)
            where id = ?`,
          [attempts, delayMs / 1000, row.id],
        );
        this.logger.warn({
          msg: 'outbox publish failed, scheduled retry',
          eventId: row.id,
          attempts,
          nextAttemptInSec: delayMs / 1000,
          error: String(e),          
        });
          metrics.increment('outbox.publish_failed');        
      }
    }
  }
}