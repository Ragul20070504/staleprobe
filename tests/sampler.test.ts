import { expect, it } from 'vitest';
import fc from 'fast-check';
import { Cooldown, shouldSample } from '../src/sampler.js';
it('is deterministic for arbitrary keys', () => {
  fc.assert(fc.property(fc.string(), fc.nat(), (key, time) => {
    expect(shouldSample(key, time, 1000, .3)).toBe(shouldSample(key, time, 1000, .3));
  }));
});
it('converges and changes across windows', () => {
  let sampled = 0, changed = 0;
  for (let i = 0; i < 20_000; i++) {
    const a = shouldSample(`user:${i}`, 0, 1000, .2);
    sampled += Number(a);
    changed += Number(a !== shouldSample(`user:${i}`, 1000, 1000, .2));
  }
  expect(sampled / 20_000).toBeGreaterThan(.18);
  expect(sampled / 20_000).toBeLessThan(.22);
  expect(changed).toBeGreaterThan(1000);
  expect(shouldSample('k', 0, 1000, 0)).toBe(false);
  expect(shouldSample('k', 0, 1000, 1)).toBe(true);
  expect(() => shouldSample('k', 0, 1000, NaN)).toThrow();
});
it('enforces cooldown and bounds digested entries', () => {
  const cooldown = new Cooldown(30, 2);
  expect(cooldown.accept('secret', 0)).toBe(true);
  expect(cooldown.accept('secret', 29)).toBe(false);
  expect(cooldown.accept('secret', 30)).toBe(true);
  cooldown.accept('b', 31); cooldown.accept('c', 32);
  expect(cooldown.size).toBe(2);
  expect(cooldown.accept('secret', 33)).toBe(true);
});
