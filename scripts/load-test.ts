/**
 * Teste de carga (diferencial) — bun run test:load
 *
 * Metodologia: N requisições BET concorrentes sobre a MESMA wallet (hot spot),
 * seguidas de reconciliação. Mede throughput, latência p50/p95/p99, taxa de
 * rejeição/conflito — e prova que o invariante saldo==Σledger sobrevive à carga.
 *
 * Env: BASE_URL, CONCURRENCY (default 25), REQUESTS (default 500)
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 25);
const REQUESTS = Number(process.env.REQUESTS ?? 500);

// ids ÚNICOS por execução — a unique (provider_id, external_transaction_id)
// sobrevive entre runs; ids determinísticos fariam rodadas subsequentes
// colidirem (503 de corrida de idempotência) em vez de medir carga.
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const playerId = randomUUID();
let walletId = '';

const res = await fetch(`${BASE}/wallets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
});
if (!res.ok) {
  console.error('falha ao criar wallet:', res.status, await res.text());
  process.exit(1);
}
const wallet = await res.json();
walletId = wallet.id;
console.log(JSON.stringify({ msg: 'wallet criada', walletId, saldo: wallet.balance.amount, runId }));

const latencies: number[] = [];
const statuses = new Map<number, number>();
let done = 0;

async function worker(n: number): Promise<void> {
  for (let i = n; i < REQUESTS; i += CONCURRENCY) {
    const start = performance.now();
    const amount = (1 + Math.floor(Math.random() * 50)).toFixed(2);
    const r = await fetch(`${BASE}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `load-${runId}-${i}`,
      },
      body: JSON.stringify({
        providerId: `load-provider-${runId}`,
        externalTransactionId: `load-${runId}-${i}`,
        playerId,
        walletId,
        roundId: `load-round-${runId}-${i}`,
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    });
    latencies.push(performance.now() - start);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    done++;
    if (done % 100 === 0) console.log(`${done}/${REQUESTS}`);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => worker(n)));
const elapsedMs = performance.now() - t0;

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1);

// invariante pós-carga: saldo materializado == Σ ledger
const recon = await fetch(`${BASE}/wallets/${walletId}/reconciliation`, { method: 'POST' });
const reconBody = await recon.json();

console.log(JSON.stringify({
  ambiente: { base: BASE, concorrencia: CONCURRENCY, requests: REQUESTS, runId },
  throughput_rps: ((REQUESTS / elapsedMs) * 1000).toFixed(1),
  latencia_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
  http_status: Object.fromEntries(statuses),
  invariante_pos_carga: {
    consistent: reconBody.consistent,
    stored: reconBody.storedBalance.amount,
    calculated: reconBody.calculatedBalance.amount,
    checkedEntries: reconBody.checkedEntries,
  },
}, null, 2));
process.exit(0);
