import type { ComparisonOptions } from './compare.js';
import type { BreakerOptions, BreakerState } from './breaker.js';
import type { BudgetOptions, DropReason } from './budget.js';

export enum AuditResult {
  FRESH = 'FRESH', STALE = 'STALE', RACE_IN_FLIGHT = 'RACE_IN_FLIGHT',
  ORIGIN_CHANGING = 'ORIGIN_CHANGING', LOADER_ERROR = 'LOADER_ERROR',
  SKIPPED = 'SKIPPED', SKIPPED_TOO_LARGE = 'SKIPPED_TOO_LARGE',
  SKIPPED_UNSUPPORTED = 'SKIPPED_UNSUPPORTED', AUDIT_ERROR = 'AUDIT_ERROR',
}
export interface AuditRule {
  pattern: string | RegExp;
  loader: (key: string, signal: AbortSignal) => Promise<unknown>;
  ttlSeconds?: number;
  sampleRate?: number;
  compare?: ComparisonOptions;
}
export interface CacheEntry { value: unknown; pttlMs?: number; ageReadFailed?: boolean }
export interface CacheAdapter<T extends object = object> {
  client: T;
  /** Read-only background read. PTTL, when requested, precedes GET. */
  read(key: string, age: boolean, signal: AbortSignal): Promise<CacheEntry>;
  decode(value: unknown): unknown;
  isMiss(value: unknown): boolean;
}
export interface AuditEvent { pattern: string; result: AuditResult; entryAgeSeconds?: number }
export interface Histogram {
  boundaries: readonly number[];
  /** Non-cumulative bins, with an additional +Infinity bin. */
  counts: number[]; count: number; sum: number;
}
export interface MetricSnapshot {
  checks: { pattern: string; result: AuditResult; count: number }[];
  entryAge: { pattern: string; outcome: AuditResult; histogram: Histogram }[];
  loaderDuration: { pattern: string; histogram: Histogram }[];
  dropped: { reason: DropReason; count: number }[];
  breakerState: BreakerState;
  coverage: { matched: number; total: number; ratio: number | null };
  stalenessRate: number | null;
}
export interface AuditExporter {
  export(snapshot: MetricSnapshot): void | Promise<void>;
  shutdown?(): void | Promise<void>;
  /** Optional synchronous observation hooks, used by the OTel histogram API. */
  recordEntryAge?(event: AuditEvent): void;
  recordLoaderDuration?(pattern: string, seconds: number): void;
}
export interface AuditorOptions {
  sampleRate?: number; sampleWindowMs?: number;
  budget?: Partial<BudgetOptions>; breaker?: Partial<BreakerOptions>;
  keyPattern?: (key: string) => string; maxPatterns?: number;
  perKeyCooldownMs?: number; maxCooldownKeys?: number; maxCompareBytes?: number;
  loaderTimeoutMs?: number; flushIntervalMs?: number; exportTimeoutMs?: number;
  onResult?: (event: AuditEvent) => void | Promise<void>;
  exporter?: AuditExporter | false;
}
export interface Auditor {
  wrap<T extends object>(adapter: CacheAdapter<T>, options: { rules: readonly AuditRule[] }): T;
  pause(): void; resume(): void; shutdown(): Promise<void>;
}
