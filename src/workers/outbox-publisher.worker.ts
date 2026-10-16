import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { QUEUES, createSqsClient, queueUrl } from '../infrastructure/sqs/queues';
import { metrics } from '../infrastructure/metrics/metrics';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number | null;
}

const MAX_ATTEMPTS = 8;
/** identifica esta instância como lease_owner (seguro com múltiplas instâncias). */
const INSTANCE_ID = `${process.env.HOSTNAME ?? 'local'}-${process.pid}`;

@Injectable()
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly sqs = createSqsClient();

  constructor(private readonly em: EntityManager) {}

  /**
   * Publica eventos pendentes do outbox.
   *
   * CLAIM ATÔMICO: o UPDATE...RETURNING com subselect FOR UPDATE SKIP LOCKED
   * segura os row locks até o fim do STATEMENT, então duas instâncias nunca
   * pegam o mesmo lote — sem depender do MessageDeduplicationId do broker
   * (otimização, nunca garantia — restr. 3 do desafio).
   *
   * Crash após o claim é recuperável: leased_until expira e outra instância
   * reassume (condição leased_until < now()).
   */
  @Cron('*/5 * * * * *')
  async publish(): Promise<void> {
    const rows = (await this.em.getConnection().execute(
      `update outbox_messages
          set lease_owner = ?, leased_until = now() + interval '30 seconds'
        where id in (
          select id from outbox_messages
           where published_at is null
             and (next_attempt_at is null or next_attempt_at <= now())
             and (lease_owner is null or leased_until < now())
           order by occurred_at
           limit 10
           for update skip locked
        )
        returning id, aggregate_id, payload, attempts`,
      [INSTANCE_ID],
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
          `update outbox_messages
              set published_at = now(), lease_owner = null, leased_until = null
            where id = ? and published_at is null`,
          [row.id],
        );
        metrics.increment('outbox.published');
        this.logger.log({ msg: 'outbox event published', eventId: row.id });
      } catch (e) {
        const attempts = (row.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          // esgota: estaciona (continua auditável na tabela) e sai do ciclo de retry
          await this.em.getConnection().execute(
            `update outbox_messages
                set attempts = ?, next_attempt_at = null, lease_owner = null, leased_until = null
              where id = ?`,
            [attempts, row.id],
          );
          this.logger.error({ msg: 'outbox event parked after max attempts', eventId: row.id, attempts });
        } else {
          const delayMs = Math.min(1_000 * 2 ** attempts, 60_000);
          await this.em.getConnection().execute(
            `update outbox_messages
                set attempts = ?, next_attempt_at = now() + make_interval(secs => ?), lease_owner = null, leased_until = null
              where id = ?`,
            [attempts, delayMs / 1000, row.id],
          );
          metrics.increment('outbox.publish_failed');
          this.logger.warn({
            msg: 'outbox publish failed, scheduled retry',
            eventId: row.id,
            attempts,
            error: errName(e),
          });
        }
      }
    }
  }
}

/** Nome/código do erro SEM vazar SQL com valores (requisito: sem dados financeiros em logs). */
function errName(e: unknown): string {
  const err = e as { code?: string; name?: string };
  return err?.code ? `${err.name ?? 'Error'}(${err.code})` : (err?.name ?? 'Error');
}
