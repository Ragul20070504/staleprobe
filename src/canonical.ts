import { createHash } from 'node:crypto';

export class CanonicalError extends Error {
  constructor(public readonly reason: 'SKIPPED_TOO_LARGE' | 'SKIPPED_UNSUPPORTED') { super(reason); }
}
export interface Fingerprint { hash: string; bytes: number }

/** RFC 6901 JSON pointers. No wildcard or dot-path interpretation. */
export function validateIgnore(ignore: readonly string[]): void {
  if (ignore.length > 100 || ignore.some(p => typeof p !== 'string' || !p.startsWith('/') || /~(?![01])/u.test(p) || p.length > 1000)) {
    throw new Error('Invalid comparison ignore pointers');
  }
}

export function fingerprint(value: unknown, maxBytes = 262_144, ignore: readonly string[] = []): Fingerprint {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid comparison size');
  validateIgnore(ignore);
  const hash = createHash('sha256');
  const seen = new Set<object>();
  const ignored = new Set(ignore);
  let bytes = 0, nodes = 0;
  function write(text: string): void {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
    hash.update(text);
  }
  function string(text: string): void {
    if (text.length > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
    write(JSON.stringify(text));
  }
  function visit(v: unknown, path: string, depth: number): void {
    if (++nodes > maxBytes || depth > 100) throw new CanonicalError('SKIPPED_TOO_LARGE');
    if (v === null || v === undefined) { write(v === null ? 'null;' : 'undefined;'); return; }
    switch (typeof v) {
      case 'string': write('s:'); string(v); return;
      case 'boolean': write(v ? 'true;' : 'false;'); return;
      case 'number': write(`n:${Object.is(v, -0) ? '0' : String(v)};`); return;
      case 'bigint': write('bigint:'); string(v.toString(10)); return;
      case 'object': break;
      default: throw new CanonicalError('SKIPPED_UNSUPPORTED');
    }
    if (seen.has(v)) throw new CanonicalError('SKIPPED_UNSUPPORTED');
    seen.add(v);
    try {
      if (v instanceof Date) {
        if (!Number.isFinite(v.getTime())) throw new CanonicalError('SKIPPED_UNSUPPORTED');
        write('date:'); string(v.toISOString()); return;
      }
      if (Buffer.isBuffer(v)) {
        if (v.length * 2 > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
        write('buffer:'); string(v.toString('hex')); return;
      }
      if (Array.isArray(v)) {
        if (v.length > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
        write('[');
        for (let i = 0; i < v.length; i++) {
          const child = `${path}/${i}`;
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
          if (descriptor && !('value' in descriptor)) throw new CanonicalError('SKIPPED_UNSUPPORTED');
          visit(ignored.has(child) ? null : descriptor?.value ?? null, child, depth + 1);
          write(',');
        }
        write(']'); return;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new CanonicalError('SKIPPED_UNSUPPORTED');
      }
      const keys = Object.keys(v);
      if (keys.length > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
      if (Object.getOwnPropertySymbols(v).length) throw new CanonicalError('SKIPPED_UNSUPPORTED');
      write('{');
      for (const key of keys.sort()) {
        if (key.length > maxBytes) throw new CanonicalError('SKIPPED_TOO_LARGE');
        const child = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (ignored.has(child)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new CanonicalError('SKIPPED_UNSUPPORTED');
        if (descriptor.value === undefined) continue;
        string(key); write(':'); visit(descriptor.value, child, depth + 1); write(',');
      }
      write('}');
    } finally { seen.delete(v); }
  }
  try { visit(value, '', 0); }
  catch (error) {
    if (error instanceof CanonicalError) throw error;
    throw new CanonicalError('SKIPPED_UNSUPPORTED');
  }
  return { hash: hash.digest('hex'), bytes };
}
