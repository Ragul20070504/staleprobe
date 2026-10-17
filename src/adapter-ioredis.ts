import type { CacheAdapter } from './types.js';

/** Structural typing keeps ioredis optional at both runtime and type-check time. */
export interface RedisReadClient {
  get(key: string): Promise<string | null>;
  pttl?(key: string): Promise<number>;
}
export function createIoredisAdapter<T extends RedisReadClient>(client: T, options: { decode?: (value: unknown) => unknown } = {}): CacheAdapter<T> {
  return {
    client,
    isMiss: value => value === null || value === undefined,
    decode: options.decode ?? (value => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value) as unknown; } catch { return value; }
    }),
    async read(key, age, signal) {
      if (signal.aborted) throw new Error('Cache read cancelled');
      let pttlMs: number | undefined;
      let ageReadFailed = false;
      if (age && client.pttl) {
        try { pttlMs = await client.pttl(key); } catch { ageReadFailed = true; }
      }
      if (signal.aborted) throw new Error('Cache read cancelled');
      const value = await client.get(key);
      return { value, ...(pttlMs === undefined ? {} : { pttlMs }), ...(ageReadFailed ? { ageReadFailed } : {}) };
    },
  };
}
