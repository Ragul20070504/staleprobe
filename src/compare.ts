import { fingerprint, type Fingerprint } from './canonical.js';
import { callSync } from './runtime.js';

export interface ComparisonOptions {
  ignore?: readonly string[];
  /** Synchronous: true means equal. Receives original decoded values. */
  fn?: (cached: unknown, fresh: unknown) => boolean;
}
export interface Snapshot { value: unknown; fingerprint: Fingerprint }
export function snapshot(value: unknown, maxBytes: number, options?: ComparisonOptions): Snapshot {
  return { value, fingerprint: fingerprint(value, maxBytes, options?.ignore) };
}
export function equal(a: Snapshot, b: Snapshot, options?: ComparisonOptions): boolean {
  if (options?.fn) {
    const result = callSync(options.fn, options, a.value, b.value);
    if (typeof result !== 'boolean') throw new Error('Invalid comparison result');
    return result;
  }
  return a.fingerprint.hash === b.fingerprint.hash;
}
