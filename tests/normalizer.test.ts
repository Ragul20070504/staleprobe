import { describe, it, expect } from 'vitest';
import { normalizeKey, PatternRegistry } from '../src/normalizer.js';
describe('normalization', () => {
  it('normalizes identifiers and preserves structure', () => {
    expect(normalizeKey('user:123')).toBe('user:*');
    expect(normalizeKey('session:550e8400-e29b-41d4-a716-446655440000')).toBe('session:*');
    expect(normalizeKey('token:abcdef0123456789abcd')).toBe('token:*');
    expect(normalizeKey('blob:AbCdEfGhIjKlMnOpQrStUvWx==')).toBe('blob:*');
    expect(normalizeKey('product:3:price')).toBe('product:*:price');
  });
  it('caps cardinality plus one overflow label', () => {
    const registry = new PatternRegistry(1);
    expect(registry.label('user:1')).toBe('user:*');
    expect(registry.label('order:1')).toBe('__other__');
    expect(registry.label('user:2')).toBe('user:*');
  });
});
