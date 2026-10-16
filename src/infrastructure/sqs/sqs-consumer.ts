import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  IdempotencyConflictError,
  IdempotencyRaceUnresolvedError,
  SubmitWagerTransactionUseCase,
} from '../../application/submit-wager-transaction.use-case';
import { QUEUES, createSqsClient, queueUrl } from './queues';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_RECEIVE_COUNT = 5;

const VALID_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
type WagerKind = (typeof VALID_KINDS)[number];

interface WagerEnvelope {
  messageId: string;
  type: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumer.name);
  private readonly sqs = createSqsClient();
  private running = false;
  private loggedQueueMissing = false;
  /** Receipt handles recebidos mas ainda não acked (para SIGTERM). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  onModuleInit(): void {
    this.running = true;
    void this.loop();
  }

  /**
   * SIGTERM: para o loop; mensagens em andamento DEVOLVIDAS (visibility 0) —
   * o processamento atual conclui e acka normalmente antes do exit.
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    const handles = [...this.inFlight];
    if (handles.length > 0) {
      this.logger.log({ msg: 'returning in-flight messages to queue', count: handles.length });
      await this.sqs.send(new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS),
        Entries: handles.map((h, i) => ({ Id: String(i), ReceiptHandle: h, VisibilityTimeout: 0 })),
      })).catch(() => undefined);
      this.inFlight.clear();
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const out = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS),
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // long polling
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));

        for (const msg of out.Messages ?? []) {
          if (!this.running) {
            // shutdown no meio do batch: devolve sem processar
            await this.returnToQueue([msg]);
            continue;
          }
          await this.process(msg);
        }
      } catch (e) {
        if (this.running) {
          const msg = String(e);
          const queueMissing = msg.includes('Expecting value') || msg.includes('QueueDoesNotExist');
          if (queueMissing) {
            // fila ausente = problema de setup, não de runtime: loga 1x e espera mais
            if (!this.loggedQueueMissing) {
              this.loggedQueueMissing = true;
              this.logger.error({
                msg: 'queue not found — run: bun run setup:queues',
                queue: QUEUES.WAGER_TRANSACTIONS,
              });
            }
          } else {
            this.loggedQueueMissing = false;
            this.logger.warn({ msg: 'receive failed, retrying', error: msg });
          }
          await new Promise((r) => setTimeout(r, queueMissing ? 10_000 : 1_000));
        }
      }
    }
  }

  private async process(msg: Message): Promise<void> {
    const receiptHandle = msg.ReceiptHandle!;
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
    this.inFlight.add(receiptHandle);

    try {
      const envelope = this.parse(msg.Body);
      if (!envelope) {
        // permanente: payload malformado nunca vai processar.
        // Sem delete = retry; no limite, o redrive policy move para a DLQ sozinho.
        this.logger.error({
          msg: 'malformed message',
          receiveCount,
          willDlq: receiveCount >= MAX_RECEIVE_COUNT,
          body: truncate(msg.Body),
        });
        return;
      }

      // MESMO use case da entrada HTTP — regras, idempotência e inbox idênticos
      await this.submit.execute(envelope.data, envelope.data.idempotencyKey, {
        channel: 'sqs',
        messageId: envelope.messageId,
        consumerName: CONSUMER_NAME,
      });

      // ack SOMENTE após commit (execute só retorna depois do commit)
      await this.sqs.send(new DeleteMessageCommand({
        QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS),
        ReceiptHandle: receiptHandle,
      }));
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        // terminal de negócio: provider+external com payload divergente.
        // A transação original já está persistida — ack.
        this.logger.warn({ msg: 'business conflict, acking', error: e.message });
        await this.sqs.send(new DeleteMessageCommand({
          QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS),
          ReceiptHandle: receiptHandle,
        }));
      } else if (e instanceof IdempotencyRaceUnresolvedError) {
        // transitório: NÃO deleta — visibility expira e SQS redelivera.
        // redrive policy garante DLQ após MAX_RECEIVE_COUNT receives.
        this.logger.warn({
          msg: 'transient failure, message will be retried',
          receiveCount,
          willDlq: receiveCount >= MAX_RECEIVE_COUNT,
          error: String(e),
        });
      } else {
        // desconhecido: trata como transitório (mais seguro que perder mensagem)
        this.logger.error({ msg: 'unexpected error, message will be retried', error: String(e) });
      }
    } finally {
      this.inFlight.delete(receiptHandle);
    }
  }

  private parse(body: string | undefined): WagerEnvelope | null {
    try {
      const parsed = JSON.parse(body ?? '') as WagerEnvelope;
      const d = parsed?.data;
      const valid = parsed?.messageId && d?.providerId && d?.externalTransactionId &&
        d?.idempotencyKey && d?.playerId && d?.walletId && d?.kind && d?.money?.amount &&
        (VALID_KINDS as readonly string[]).includes(d.kind); // rejeita kind inválido
      return valid ? parsed : null;
    } catch {
      return null;
    }
  }

  private async returnToQueue(messages: Message[]): Promise<void> {
    const entries = messages
      .filter((m) => m.ReceiptHandle)
      .map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 }));
    if (entries.length === 0) return;
    await this.sqs.send(new ChangeMessageVisibilityBatchCommand({
      QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS),
      Entries: entries,
    })).catch(() => undefined);
  }
}

function truncate(s: string | undefined, n = 200): string {
  return s ? (s.length > n ? s.slice(0, n) + '…' : s) : '';
}