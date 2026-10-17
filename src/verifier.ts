import { CanonicalError } from './canonical.js';
import { equal, snapshot } from './compare.js';
import { callSync, delay, OperationError, OperationGate } from './runtime.js';
import { AuditResult, type AuditRule, type CacheAdapter, type AuditEvent } from './types.js';
import type { DropReason } from './budget.js';

class LoaderFailure extends Error {}
class ReadFailure extends Error {}
export interface VerifierContext {
  loaderGate: OperationGate; readGate: OperationGate;
  timeoutMs: number; maxBytes: number;
  observeLoader: (failed: boolean, ms: number) => void;
  drop: (reason: DropReason) => void;
  random?: () => number;
  now?: () => number;
}
export async function verify(
  adapter: CacheAdapter, key: string, cached: unknown, rule: AuditRule,
  signal: AbortSignal, pattern: string, context: VerifierContext,
): Promise<AuditEvent> {
  let age: number | undefined;
  const event = (result: AuditResult): AuditEvent => age === undefined ? { pattern, result } : { pattern, result, entryAgeSeconds: age };
  const now = context.now ?? (() => performance.now());
  const snap = (value: unknown) => snapshot(value, context.maxBytes, rule.compare);
  const read = async (ageEnabled: boolean) => {
    try { return await context.readGate.run(s => adapter.read(key, ageEnabled, s), context.timeoutMs, signal); }
    catch (error) {
      if (error instanceof OperationError && error.reason === 'CANCELLED') throw error;
      throw new ReadFailure();
    }
  };
  const load = async (): Promise<unknown> => {
    const start = now();
    try {
      const value = await context.loaderGate.run(s => rule.loader(key, s), context.timeoutMs, signal);
      context.observeLoader(false, Math.max(0, now() - start)); return value;
    } catch (error) {
      if (error instanceof OperationError && (error.reason === 'SATURATED' || error.reason === 'CANCELLED')) throw error;
      context.observeLoader(true, Math.max(0, now() - start));
      throw new LoaderFailure();
    }
  };
  try {
    if (signal.aborted) throw new OperationError('CANCELLED');
    const original = snap(callSync(adapter.decode, adapter, cached));
    if (rule.ttlSeconds !== undefined) {
      const entry = await read(true);
      if (entry.ageReadFailed) context.drop('ADAPTER_ERROR');
      if (entry.pttlMs !== undefined && Number.isFinite(entry.pttlMs) && entry.pttlMs >= 0 && entry.pttlMs <= rule.ttlSeconds * 1000) {
        age = rule.ttlSeconds - entry.pttlMs / 1000;
      }
    }
    const fresh1 = snap(await load());
    if (equal(original, fresh1, rule.compare)) return event(AuditResult.FRESH);
    await delay(50 + Math.floor((context.random ?? Math.random)() * 151), signal);
    const cached2 = snap(callSync(adapter.decode, adapter, (await read(false)).value));
    const fresh2 = snap(await load());
    if (!equal(cached2, original, rule.compare)) return event(AuditResult.RACE_IN_FLIGHT);
    if (!equal(fresh2, fresh1, rule.compare)) return event(AuditResult.ORIGIN_CHANGING);
    if (equal(cached2, fresh2, rule.compare)) return event(AuditResult.FRESH);
    return event(AuditResult.STALE);
  } catch (error) {
    if (error instanceof CanonicalError) return event(AuditResult[error.reason]);
    if (error instanceof LoaderFailure) return event(AuditResult.LOADER_ERROR);
    if (error instanceof ReadFailure) { context.drop('ADAPTER_ERROR'); return event(AuditResult.AUDIT_ERROR); }
    if (error instanceof OperationError && error.reason === 'CANCELLED') {
      context.drop('CANCELLED'); return event(AuditResult.SKIPPED);
    }
    if (error instanceof OperationError && error.reason === 'SATURATED') {
      context.drop('LOADER_SATURATED'); return event(AuditResult.SKIPPED);
    }
    context.drop('AUDIT_ERROR'); return event(AuditResult.AUDIT_ERROR);
  }
}
