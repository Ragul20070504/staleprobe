import { afterEach, expect, it, vi } from 'vitest';
import { createAuditor, createIoredisAdapter, type Auditor, type AuditEvent } from '../src/index.js';
import { equal, snapshot } from '../src/compare.js';
const auditors: Auditor[] = [];
afterEach(async () => { for (const a of auditors.splice(0)) await a.shutdown(); vi.useRealTimers(); });
it('rejects accidental async comparators once and consumes their failures', async () => {
  const fn = vi.fn(async () => { throw Error('private'); });
  const options = { fn: fn as unknown as () => boolean };
  const a = snapshot(1, 100), b = snapshot(2, 100);
  expect(() => equal(a, b, options)).toThrow('FAILED');
  expect(() => equal(a, b, options)).toThrow('FAILED');
  await Promise.resolve(); expect(fn).toHaveBeenCalledOnce();
});
it('isolates rejected async normalizers on the request path', async () => {
  vi.useFakeTimers(); const normalize = vi.fn(async () => { throw Error('private'); });
  const a = createAuditor({ sampleRate: 1, perKeyCooldownMs: 0, exporter: false, keyPattern: normalize as unknown as () => string }); auditors.push(a);
  const cache = a.wrap(createIoredisAdapter({ async get(_key: string) { return '1'; } }), { rules: [{ pattern: '*', loader: async () => 1 }] });
  expect(await cache.get('secret')).toBe('1'); expect(await cache.get('secret')).toBe('1');
  await vi.advanceTimersByTimeAsync(1); expect(normalize).toHaveBeenCalledOnce();
});
it('isolates async decoders', async () => {
  vi.useFakeTimers(); const events: AuditEvent[] = [];
  const decode = vi.fn(async () => { throw Error('private'); });
  const a = createAuditor({ sampleRate: 1, perKeyCooldownMs: 0, exporter: false, onResult: e => { events.push(e); } }); auditors.push(a);
  const cache = a.wrap(createIoredisAdapter({ async get(_key: string) { return '1'; } }, { decode }), { rules: [{ pattern: '*', loader: async () => 1 }] });
  expect(await cache.get('secret')).toBe('1'); await vi.advanceTimersByTimeAsync(1);
  expect(events[0]?.result).toBe('AUDIT_ERROR');
  await cache.get('secret'); await vi.advanceTimersByTimeAsync(1);
  expect(decode).toHaveBeenCalledOnce(); expect(events[1]?.result).toBe('AUDIT_ERROR');
});
