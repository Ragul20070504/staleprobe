import { afterEach, expect, it, vi } from 'vitest';
import { verify, type VerifierContext } from '../src/verifier.js';
import { OperationGate } from '../src/runtime.js';
import { AuditResult, type CacheAdapter, type AuditRule } from '../src/types.js';
afterEach(() => vi.useRealTimers());
function setup(cached2: unknown, fresh: unknown[], compare?: AuditRule['compare']) {
  const adapter: CacheAdapter = { client: {}, decode: v => v, isMiss: v => v == null, read: vi.fn(async () => ({ value: cached2, pttlMs: 7000 })) };
  const rule: AuditRule = { pattern: '*', loader: vi.fn(async () => fresh.shift()), ...(compare ? { compare } : {}) };
  const context: VerifierContext = { loaderGate: new OperationGate(1), readGate: new OperationGate(1), timeoutMs: 100, maxBytes: 1000, observeLoader: vi.fn(), drop: vi.fn(), random: () => 0, now: Date.now };
  return { adapter, rule, context };
}
it.each([
  [1, [1], AuditResult.FRESH],
  [3, [2, 2], AuditResult.RACE_IN_FLIGHT],
  [1, [2, 3], AuditResult.ORIGIN_CHANGING],
  [1, [2, 2], AuditResult.STALE],
])('classifies cache=%s fresh=%s', async (cached2, fresh, result) => {
  vi.useFakeTimers(); const { adapter, rule, context } = setup(cached2, [...fresh]);
  const p = verify(adapter, 'secret', 1, rule, new AbortController().signal, 'safe:*', context);
  await vi.advanceTimersByTimeAsync(55); expect((await p).result).toBe(result);
});
it('supports custom comparison throughout including second FRESH branch', async () => {
  // A tolerance comparator can be non-transitive: |0-2|>1, |0-1|<=1, |2-1|<=1.
  vi.useFakeTimers(); const { adapter, rule, context } = setup(1, [2, 2], { fn: (a, b) => Math.abs(Number(a) - Number(b)) <= 1 });
  const p = verify(adapter, 'k', 0, rule, new AbortController().signal, '*', context);
  await vi.advanceTimersByTimeAsync(55); expect((await p).result).toBe(AuditResult.FRESH);
});
it('handles exceptions, timeout, cancellation and stuck-loader slots', async () => {
  vi.useFakeTimers(); const { adapter, rule, context } = setup(1, []);
  rule.loader = async () => { throw Error('private'); };
  expect((await verify(adapter, 'secret', 1, rule, new AbortController().signal, '*', context)).result).toBe('LOADER_ERROR');
  let loaderSignal: AbortSignal | undefined;
  rule.loader = async (_k, signal) => { loaderSignal = signal; return new Promise(() => {}); };
  const controller = new AbortController();
  const p = verify(adapter, 'secret', 1, rule, controller.signal, '*', context);
  await vi.advanceTimersByTimeAsync(101); expect((await p).result).toBe('LOADER_ERROR');
  expect(loaderSignal?.aborted).toBe(true); expect(context.loaderGate.size).toBe(1);
  expect((await verify(adapter, 'secret', 1, rule, controller.signal, '*', context)).result).toBe('SKIPPED');
  controller.abort(); expect((await verify(adapter, 'secret', 1, rule, controller.signal, '*', context)).result).toBe('SKIPPED');
});
it('records meaningful age only and skips oversized inputs', async () => {
  const { adapter, rule, context } = setup(1, [1]); rule.ttlSeconds = 10;
  expect((await verify(adapter, 'k', 1, rule, new AbortController().signal, '*', context)).entryAgeSeconds).toBe(3);
  expect((await verify(adapter, 'k', 'x'.repeat(2000), rule, new AbortController().signal, '*', context)).result).toBe('SKIPPED_TOO_LARGE');
});
