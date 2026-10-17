import { expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { fingerprint } from '../src/canonical.js';
import { equal, snapshot } from '../src/compare.js';
it('sorts recursively, omits undefined and supports ignored pointers', () => {
  expect(fingerprint({ b: { z: 1, a: 2 }, a: undefined })).toEqual(fingerprint({ b: { a: 2, z: 1 } }));
  expect(fingerprint({ a: { x: 1 }, v: [1, 3] }, 1000, ['/a/x', '/v/1']))
    .toEqual(fingerprint({ a: { x: 5 }, v: [1, 8] }, 1000, ['/a/x', '/v/1']));
  expect(fingerprint({ 'a/b': 1 }, 100, ['/a~1b'])).toEqual(fingerprint({}, 100));
});
it('has type tags, stable special values and correct bytes/hash', () => {
  for (const v of [new Date('2020-01-01'), 3n, Buffer.from('abc'), NaN, Infinity, -Infinity, null, undefined]) {
    expect(fingerprint(v)).toEqual(fingerprint(v));
  }
  expect(fingerprint(3n)).not.toEqual(fingerprint('3'));
  expect(fingerprint(new Date('2020-01-01'))).not.toEqual(fingerprint('2020-01-01T00:00:00.000Z'));
  const encoded = 's:"é"';
  expect(fingerprint('é')).toEqual({ bytes: Buffer.byteLength(encoded), hash: createHash('sha256').update(encoded).digest('hex') });
});
it('rejects huge, circular, unsupported and accessor values safely', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const v of [circular, Symbol(), () => 1, new Map(), new Date(NaN), { get secret() { throw Error('secret'); } }]) {
    expect(() => fingerprint(v)).toThrow('SKIPPED_UNSUPPORTED');
  }
  for (const v of ['x'.repeat(1_000_000), Array(1000).fill(1), Buffer.alloc(1000), { a: 'x'.repeat(100) }]) {
    expect(() => fingerprint(v, 20)).toThrow('SKIPPED_TOO_LARGE');
  }
});
it('is order independent for generated records', () => {
  fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), obj => {
    const reversed = Object.fromEntries(Object.entries(obj).reverse());
    expect(fingerprint(obj)).toEqual(fingerprint(reversed));
  }));
});
it('isolates synchronous custom comparison and requires booleans', () => {
  const a = snapshot(1, 100), b = snapshot(2, 100);
  expect(equal(a, b, { fn: () => true })).toBe(true);
  expect(() => equal(a, b, { fn: () => { throw Error('private'); } })).toThrow();
});
