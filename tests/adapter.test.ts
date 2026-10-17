import { expect, it, vi } from 'vitest';
import { createIoredisAdapter } from '../src/index.js';
it.each([-2, -1, 0, 9000])('returns PTTL %s before GET without mutating', async ttl => {
  const order: string[] = [];
  const client = { get: vi.fn(async () => { order.push('get'); return null; }), pttl: vi.fn(async () => { order.push('pttl'); return ttl; }) };
  const adapter = createIoredisAdapter(client);
  expect(await adapter.read('secret', true, new AbortController().signal)).toEqual({ value: null, pttlMs: ttl });
  expect(order).toEqual(['pttl', 'get']);
});
it('handles optional PTTL, PTTL failures and decoding', async () => {
  const adapter = createIoredisAdapter({ get: async () => 'plain' });
  expect(await adapter.read('k', true, new AbortController().signal)).toEqual({ value: 'plain' });
  expect(adapter.decode('plain')).toBe('plain'); expect(adapter.decode('{"a":1}')).toEqual({ a: 1 });
  const failed = createIoredisAdapter({ get: async () => '1', pttl: async () => { throw Error('private'); } });
  expect((await failed.read('k', true, new AbortController().signal)).ageReadFailed).toBe(true);
});
