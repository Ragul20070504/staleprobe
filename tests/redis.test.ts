import { expect, it } from 'vitest';
import { createAuditor, createIoredisAdapter, type AuditEvent } from '../src/index.js';
// Only invoked explicitly against a disposable Redis instance; ioredis is optional.
it.skipIf(!process.env.REDIS_URL)('verifies a real Redis read without changing value or TTL', async () => {
  const { Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL!);
  const key = `staleprobe-test:${process.pid}`;
  const events: AuditEvent[] = [];
  const auditor = createAuditor({ sampleRate: 1, exporter: false, onResult: e => { events.push(e); } });
  try {
    await client.set(key, '1', 'EX', 60);
    const cache = auditor.wrap(createIoredisAdapter(client), { rules: [{ pattern: 'staleprobe-test:*', loader: async () => 1, ttlSeconds: 60 }] });
    expect(await cache.get(key)).toBe('1');
    for (let i = 0; i < 100 && events.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(events[0]?.result).toBe('FRESH'); expect(await client.get(key)).toBe('1');
    expect(await client.pttl(key)).toBeGreaterThan(58_000);
  } finally { await auditor.shutdown(); await client.del(key); await client.quit(); }
});
