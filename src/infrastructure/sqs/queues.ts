import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  QueueDoesNotExist,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { env } from '../../config/env';

export const TRANSACTIONS_QUEUE = 'wager-transactions.fifo';
export const TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE = 'wager-events.fifo';

export const sqsClient = new SQSClient({
  region: env.sqs.region,
  endpoint: env.sqs.endpoint,
  // credenciais dummy para LocalStack — em produção virão do IAM role
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const urlCache = new Map<string, string>();

export async function queueUrl(name: string): Promise<string> {
  const cached = urlCache.get(name);
  if (cached) return cached;
  try {
    const res = await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }));
    urlCache.set(name, res.QueueUrl!);
    return res.QueueUrl!;
  } catch (err) {
    if (err instanceof QueueDoesNotExistError) {
      throw new Error(`queue "${name}" não existe — rode scripts/init-queues.sh`);
    }
    throw err;
  }
}

/** Idempotente: cria DLQ, fila principal com redrive policy e fila de eventos. */
export async function ensureQueues(): Promise<void> {
  await createFifoQueue(TRANSACTIONS_DLQ);
  await createFifoQueue(TRANSACTIONS_QUEUE, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: `arn:aws:sqs:${env.sqs.region}:000000000000:${TRANSACTIONS_DLQ}`,
      maxReceiveCount: '5',
    }),
  });
  await createFifoQueue(EVENTS_QUEUE);
}

async function createFifoQueue(name: string, attributes?: Record<string, string>): Promise<void> {
  try {
    await sqsClient.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...attributes },
    }));
  } catch (err) {
    if (!(err instanceof QueueNameExistsError)) throw err;
  }
}

/** Envio FIFO com deduplicação no broker (otimização — a garantia final continua no banco). */
export async function sendFifoMessage(
  url: string,
  body: string,
  messageGroupId: string,
  messageDeduplicationId: string,
): Promise<void> {
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: url,
    MessageBody: body,
    MessageGroupId: messageGroupId,
    MessageDeduplicationId: messageDeduplicationId,
  }));
}