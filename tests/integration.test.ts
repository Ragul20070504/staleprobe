import { afterEach, expect, it, vi } from 'vitest';
import { createAuditor, createIoredisAdapter, type AuditEvent, type Auditor, type AuditorOptions, type MetricSnapshot, type AuditRule } from '../src/index.js';

const auditors: Auditor[] = [];
afterEach(async () => {
  for (const auditor of auditors.splice(0)) await auditor.shutdown();
  vi.useRealTimers(); vi.unstubAllEnvs();
});
function setup(options: AuditorOptions = {}, rules?: AuditRule[]) {
  const snapshots: MetricSnapshot[] = [], events: AuditEvent[] = [], order: string[] = [];
  const values = new Map([['product:123', '{"price":1}'], ['user:1', '1']]);
  const client = {
    values,
    get: vi.fn(async function (this: { values: Map<string, string> }, key: string) { order.push('get'); return this.values.get(key) ?? null; }),
    mget: vi.fn(async function (this: { values: Map<string, string> }, ...args: (string | string[])[]) { return args.flat().map(k => this.values.get(k) ?? null); }),
    pttl: vi.fn(async () => { order.push('pttl'); return 7000; }),
    set: vi.fn(), del: vi.fn(), expire: vi.fn(), pexpire: vi.fn(), flushdb: vi.fn(), unlink: vi.fn(),
    ping: vi.fn(function (this: unknown, arg: string) { expect(this).toBe(client); return arg; }),
  };
  const loader = vi.fn(async () => ({ price: 1 }));
  const auditor = createAuditor({ sampleRate: 1, perKeyCooldownMs: 0, exporter: { export: s => { snapshots.push(s); } }, onResult: e => { events.push(e); }, ...options });
  auditors.push(auditor);
  const wrapped = auditor.wrap(createIoredisAdapter(client), { rules: rules ?? [{ pattern: 'product:*', loader, ttlSeconds: 10 }] });
  return { client, wrapped, auditor, snapshots, events, loader, order };
}
it('returns original value before any audit work and never mutates the cache', async () => {
  vi.useFakeTimers(); const s = setup();
  expect(await s.wrapped.get('product:123')).toBe('{"price":1}');
  expect(s.loader).not.toHaveBeenCalled(); expect(s.client.pttl).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.events).toEqual([{ pattern: 'product:*', result: 'FRESH', entryAgeSeconds: 3 }]);
  expect(s.order).toEqual(['get', 'pttl', 'get']);
  for (const method of ['set', 'del', 'expire', 'pexpire', 'flushdb', 'unlink'] as const) expect(s.client[method]).not.toHaveBeenCalled();
  expect(s.wrapped.ping('ok')).toBe('ok');
  await s.auditor.shutdown(); expect(JSON.stringify(s.snapshots)).not.toContain('123'); expect(JSON.stringify(s.snapshots)).not.toContain('price');
});
it('preserves original read errors and isolates loader, callback and exporter failures', async () => {
  vi.useFakeTimers();
  const loader = vi.fn(async () => { throw Error('secret-key private-value'); });
  const s = setup({ onResult: () => { throw Error('private'); } }, [{ pattern: '*', loader }]);
  expect(await s.wrapped.get('product:123')).toBe('{"price":1}'); await vi.advanceTimersByTimeAsync(1);
  expect(loader).toHaveBeenCalledOnce(); await s.auditor.shutdown();
  expect(s.snapshots[0]?.checks[0]?.result).toBe('LOADER_ERROR');
  expect(s.snapshots[0]?.dropped).toContainEqual({ reason: 'CALLBACK_ERROR', count: 1 });
  const err = Error('original'); s.client.get.mockRejectedValueOnce(err);
  await expect(s.wrapped.get('bad')).rejects.toBe(err);
  const failing = setup({ exporter: { export() { throw Error('private'); } } });
  await failing.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(1); await failing.auditor.shutdown();
});
it('disabled mode preserves client identity and creates no timers, metrics or reads', async () => {
  vi.useFakeTimers(); vi.stubEnv('CACHE_AUDIT_DISABLED', '1'); const s = setup();
  expect(s.wrapped).toBe(s.client); await s.wrapped.get('product:123');
  expect(vi.getTimerCount()).toBe(0); expect(s.loader).not.toHaveBeenCalled();
  expect(s.client.pttl).not.toHaveBeenCalled(); await s.auditor.shutdown(); expect(s.snapshots).toEqual([]);
});
it('handles per-rule override, mixed mget hits, misses and coverage', async () => {
  vi.useFakeTimers(); const load = vi.fn(async () => 1);
  const s = setup({ sampleRate: 0 }, [{ pattern: 'user:*', loader: load, sampleRate: 1 }, { pattern: 'product:*', loader: load, sampleRate: 0 }]);
  expect(await s.wrapped.mget(['user:1', 'product:123', 'missing'])).toEqual(['1', '{"price":1}', null]);
  s.client.values.set('unconfigured:1', 'secret-value'); await s.wrapped.get('unconfigured:1');
  await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledOnce(); await s.auditor.shutdown();
  expect(s.snapshots[0]?.coverage).toEqual({ matched: 2, total: 3, ratio: 2 / 3 });
  expect(s.snapshots[0]?.checks).toContainEqual({ pattern: '__unmatched__', result: 'SKIPPED', count: 1 });
});
it('chooses first matching rule, resets regex state and obeys cooldowns', async () => {
  vi.useFakeTimers(); const first = vi.fn(async () => 1), second = vi.fn(async () => 2);
  const s = setup({ perKeyCooldownMs: 30 }, [{ pattern: /^user:/g, loader: first }, { pattern: '*', loader: second }]);
  await s.wrapped.get('user:1'); await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1);
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30); await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1);
  expect(first).toHaveBeenCalledTimes(2);
});
it('pause and resume stop scheduling; shutdown is idempotent and cancels active work', async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined;
  const loader = vi.fn(async (_key: string, s: AbortSignal) => { signal = s; return new Promise(() => {}); });
  const s = setup({}, [{ pattern: '*', loader }]);
  s.auditor.pause(); await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1); expect(loader).not.toHaveBeenCalled();
  s.auditor.resume(); await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1);
  await s.auditor.shutdown(); expect(signal?.aborted).toBe(true);
  expect(s.auditor.shutdown()).toBe(s.auditor.shutdown()); s.auditor.resume(); await s.wrapped.get('user:1'); expect(loader).toHaveBeenCalledOnce();
});
it('bounds queue saturation and loader timeouts in the full lifecycle', async () => {
  vi.useFakeTimers(); const loader = vi.fn(async () => new Promise(() => {}));
  const s = setup({ loaderTimeoutMs: 20, budget: { queueSize: 1, maxConcurrent: 1, perSecond: 1 } }, [{ pattern: '*', loader }]);
  await s.wrapped.get('user:1'); await s.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(25);
  await s.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(1000); await s.auditor.shutdown();
  expect(loader).toHaveBeenCalledOnce();
  expect(s.snapshots[0]?.dropped).toEqual(expect.arrayContaining([{ reason: 'QUEUE_FULL', count: 1 }, { reason: 'LOADER_SATURATED', count: 1 }]));
});
it('opens and recovers the breaker without treating stale results as errors', async () => {
  vi.useFakeTimers(); let fail = true;
  const loader = vi.fn(async () => { if (fail) throw Error('private'); return 1; });
  const s = setup({ breaker: { minObservations: 1, cooldownMs: 20 } }, [{ pattern: '*', loader }]);
  await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1);
  await s.wrapped.get('user:1'); expect(loader).toHaveBeenCalledOnce();
  fail = false; await vi.advanceTimersByTimeAsync(20); await s.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1);
  expect(loader).toHaveBeenCalledTimes(2); await s.auditor.shutdown(); expect(s.snapshots[0]?.breakerState).toBe('CLOSED');
});
it('isolates normalizer, comparison and adapter errors', async () => {
  vi.useFakeTimers();
  const badNormalizer = setup({ keyPattern: () => { throw Error('private'); } });
  await badNormalizer.wrapped.get('product:123'); expect(badNormalizer.loader).not.toHaveBeenCalled(); await badNormalizer.auditor.shutdown();
  expect(badNormalizer.snapshots[0]?.dropped[0]?.reason).toBe('NORMALIZER_ERROR');
  const badCompare = setup({}, [{ pattern: '*', loader: async () => 1, compare: { fn: () => { throw Error('private'); } } }]);
  await badCompare.wrapped.get('user:1'); await vi.advanceTimersByTimeAsync(1); expect(badCompare.events[0]?.result).toBe('AUDIT_ERROR');
  const disconnected = setup(); await disconnected.wrapped.get('product:123'); disconnected.client.get.mockRejectedValue(Error('private')); await vi.advanceTimersByTimeAsync(1);
  expect(disconnected.events[0]?.result).toBe('AUDIT_ERROR');
});
it.each([-1, NaN, Infinity, 2])('rejects invalid sample rate %s', sampleRate => {
  expect(() => createAuditor({ sampleRate })).toThrow();
});
it('caps metric labels and keeps arbitrary key suffixes private', async () => {
  vi.useFakeTimers(); const s = setup({ maxPatterns: 1 }, [{ pattern: 'user:*', loader: async () => 1 }, { pattern: 'product:*', loader: async () => ({ price: 1 }) }]);
  await s.wrapped.get('user:1'); await s.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(1);
  expect(s.events.map(e => e.pattern)).toEqual(['user:*', '__other__']);
});
it('does not accumulate callback promises that ignore completion', async () => {
  vi.useFakeTimers(); const cb = vi.fn(async () => new Promise<void>(() => {}));
  const s = setup({ onResult: cb, loaderTimeoutMs: 20, budget: { maxConcurrent: 1 } });
  await s.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(25);
  await s.wrapped.get('product:123'); await vi.advanceTimersByTimeAsync(25);
  expect(cb).toHaveBeenCalledOnce(); await s.auditor.shutdown();
});
it('keeps exact rule keys and short textual identifiers out of events', async () => {
  vi.useFakeTimers(); const s = setup({}, [{ pattern: 'user:alice', loader: async () => 1 }]);
  s.client.values.set('user:alice', '1');
  await s.wrapped.get('user:alice'); await vi.advanceTimersByTimeAsync(1);
  expect(s.events[0]?.pattern).toBe('__rule_1__');
  expect(JSON.stringify(s.events)).not.toContain('alice');
});
it('passes application writes and their arguments through with original context', () => {
  const s = setup(); s.wrapped.set('application-key', 'application-value');
  expect(s.client.set).toHaveBeenCalledWith('application-key', 'application-value');
  expect(s.client.set.mock.contexts[0]).toBe(s.client);
});
it('shutdown immediately after a read prevents scheduled loaders from starting', async () => {
  vi.useFakeTimers(); const s = setup();
  await s.wrapped.get('product:123'); await s.auditor.shutdown();
  await vi.advanceTimersByTimeAsync(10); expect(s.loader).not.toHaveBeenCalled();
});
it.each([
  { budget: { maxConcurrent: 0 } }, { budget: { queueSize: 1.5 } },
  { maxCompareBytes: 0 }, { loaderTimeoutMs: 2 ** 32 }, { maxPatterns: -1 },
  { breaker: { minObservations: 10, maxObservations: 1 } }, { perKeyCooldownMs: -1 },
])('validates option boundaries: %j', options => {
  expect(() => createAuditor(options)).toThrow();
});
