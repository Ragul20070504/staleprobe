import { Redis } from 'ioredis';
import pg from 'pg';
import { createAuditor, createIoredisAdapter } from 'staleprobe';
import { createApp } from './app.mjs';
import { createTelemetry } from './telemetry.mjs';

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) throw Error(`Invalid ${name}`);
  return value;
}
const ttlSeconds = integer('CACHE_TTL_SECONDS', 300);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', () => { /* Request errors use sanitized HTTP responses. */ });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 });
pool.on('error', () => {});
const { reader, provider, exporter } = createTelemetry(integer('METRICS_PORT', 9464));
await reader.startServer();
const auditor = createAuditor({
  sampleRate: Number(process.env.CACHE_AUDIT_SAMPLE_RATE ?? 1),
  exporter,
});
const cache = auditor.wrap(createIoredisAdapter(redis), {
  rules: [{ pattern: 'product:*', ttlSeconds, async loader(key, signal) {
    signal.throwIfAborted();
    const { rows } = await pool.query('SELECT id, name, price::float8 AS price FROM products WHERE id = $1', [key.slice('product:'.length)]);
    signal.throwIfAborted();
    return rows[0] ?? null;
  } }],
});
const server = createApp({ cache, redis, pool, ttlSeconds }).listen(integer('PORT', 3000), '0.0.0.0', () => {
  console.log('Catalog listening; metrics are available on the configured metrics port at /metrics');
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.close();
  await auditor.shutdown(); await provider.shutdown();
  await Promise.allSettled([redis.quit(), pool.end()]);
}
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
