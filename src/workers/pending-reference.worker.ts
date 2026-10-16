import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';

interface PendingRow {
  id: string;
}

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  constructor(
    private readonly em: EntityManager,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  @Cron('*/10 * * * * *') // a cada 10s
  async run(): Promise<void> {
    const rows = (await this.em.getConnection().execute(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE'
          and (next_attempt_at is null or next_attempt_at <= now())
        order by next_attempt_at
        limit 10
        for update skip locked`,
    )) as PendingRow[];

    for (const row of rows) {
      try {
        await this.submit.reprocess(row.id);
      } catch (e) {
        this.logger.warn({
          msg: 'reprocess failed, will retry on next cycle',
          transactionId: row.id,
          error: String(e),
        });
      }
    }
  }
}