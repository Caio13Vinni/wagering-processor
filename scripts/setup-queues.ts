import { ensureQueues } from '../src/infrastructure/sqs/queues';

await ensureQueues();
console.log('✅ filas criadas: wager-transactions.fifo (+DLQ), wager-events.fifo');
process.exit(0);