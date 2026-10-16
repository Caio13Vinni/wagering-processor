import {
  CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { env } from '../../config/env';

export const QUEUES = {
  WAGER_TRANSACTIONS: 'wager-transactions.fifo',
  WAGER_TRANSACTIONS_DLQ: 'wager-transactions-dlq.fifo',
  WAGER_EVENTS: 'wager-events.fifo',
} as const;

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: env.sqs.endpoint,
    region: env.sqs.region,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, // LocalStack
  });
}

/** LocalStack aceita URL no formato {endpoint}/{account}/{queueName}. */
export function queueUrl(name: string): string {
  return `${env.sqs.endpoint}/000000000000/${name}`;
}

const FIFO_ATTRS = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

/** Idempotente: cria as filas ou atualiza atributos se já existirem. */
export async function ensureQueues(): Promise<void> {
  const client = createSqsClient();

  await upsertQueue(client, QUEUES.WAGER_TRANSACTIONS_DLQ, FIFO_ATTRS);
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl(QUEUES.WAGER_TRANSACTIONS_DLQ),
      AttributeNames: ['QueueArn'],
    }))
  ).Attributes?.QueueArn;

  await upsertQueue(client, QUEUES.WAGER_TRANSACTIONS, {
    ...FIFO_ATTRS,
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: '5',
    }),
  });

  await upsertQueue(client, QUEUES.WAGER_EVENTS, FIFO_ATTRS);
}

async function upsertQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<void> {
  try {
    await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  } catch (e) {
    // fila já existe com atributos diferentes → atualiza em vez de falhar.
    // detecção por string é proposital: o formato varia entre runtimes
    // (Bun vs Node expõem propriedades do erro do SDK de formas diferentes)
    const s = String(e);
    if (s.includes('QueueNameExists') || s.includes('queue already exists') ||
        (e as { name?: string }).name === 'QueueNameExists') {
      await client.send(new SetQueueAttributesCommand({
        QueueUrl: queueUrl(name),
        Attributes: attributes,
      }));
    } else {
      throw e;
    }
  }
}