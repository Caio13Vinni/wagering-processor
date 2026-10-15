export const env = {
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'wager',
    password: process.env.DB_PASSWORD ?? 'wager',
    name: process.env.DB_NAME ?? 'wagering',
  },
  sqs: {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:9324',
    region: process.env.AWS_REGION ?? 'us-east-1',
    transactionsQueueUrl:
      process.env.SQS_TRANSACTIONS_QUEUE_URL ??
      'http://localhost:9324/000000000000/wager-transactions.fifo',
  },
  port: Number(process.env.PORT ?? 3000),
};