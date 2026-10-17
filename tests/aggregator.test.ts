import { afterEach, expect, it, vi } from 'vitest';
import { Aggregator } from '../src/aggregator.js';
import { AuditResult, type MetricSnapshot } from '../src/types.js';
import { createOtelExporter } from '../src/exporter-otel.js';
import type { Meter } from '@opentelemetry/api';
afterEach(() => vi.useRealTimers());
it('aggregates bounded numeric bins and excludes inconclusive results', async () => {
  const snapshots: MetricSnapshot[] = [];
  const aggregator = new Aggregator({ export: s => { snapshots.push(s); } }, () => 'CLOSED', 10000, 100);
  aggregator.coverage(true); aggregator.coverage(false);
  aggregator.record({ pattern: 'user:*', result: AuditResult.STALE, entryAgeSeconds: 6 });
  aggregator.record({ pattern: 'user:*', result: AuditResult.FRESH });
  aggregator.record({ pattern: 'user:*', result: AuditResult.LOADER_ERROR });
  for (const result of [AuditResult.RACE_IN_FLIGHT, AuditResult.ORIGIN_CHANGING, AuditResult.SKIPPED, AuditResult.SKIPPED_TOO_LARGE, AuditResult.SKIPPED_UNSUPPORTED, AuditResult.AUDIT_ERROR]) {
    aggregator.record({ pattern: 'user:*', result });
  }
  aggregator.loader('user:*', 50); aggregator.drop('QUEUE_FULL');
  await aggregator.flush();
  expect(snapshots[0]?.stalenessRate).toBe(.5); expect(snapshots[0]?.coverage.ratio).toBe(.5);
  expect(snapshots[0]?.entryAge[0]?.histogram.counts[2]).toBe(1);
  await aggregator.shutdown(); expect(snapshots[1]?.stalenessRate).toBeNull();
});
it('isolates failing exporters and prevents overlap even after timeout', async () => {
  vi.useFakeTimers(); const exportFn = vi.fn(() => new Promise<void>(() => {}));
  const aggregator = new Aggregator({ export: exportFn }, () => 'CLOSED', 10000, 100);
  const p = aggregator.flush(); expect(aggregator.flush()).toBe(p);
  await vi.advanceTimersByTimeAsync(101); await p; await aggregator.flush();
  expect(exportFn).toHaveBeenCalledTimes(1); await aggregator.shutdown();
});
it('exports stable OTel instrument names, exact observations and safe attributes', () => {
  const instruments = new Map<string, { add: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn>; addCallback: ReturnType<typeof vi.fn>; removeCallback: ReturnType<typeof vi.fn> }>();
  const make = (name: string) => { const i = { add: vi.fn(), record: vi.fn(), addCallback: vi.fn(), removeCallback: vi.fn() }; instruments.set(name, i); return i; };
  const meter = { createCounter: make, createHistogram: make, createObservableGauge: make } as unknown as Meter;
  const exporter = createOtelExporter({ meter });
  exporter.recordEntryAge!({ pattern: 'user:*', result: AuditResult.FRESH, entryAgeSeconds: 3 });
  exporter.recordLoaderDuration!('user:*', .01);
  expect(instruments.size).toBe(6);
  expect(instruments.get('cache_audit_entry_age_seconds')?.record).toHaveBeenCalledWith(3, { pattern: 'user:*', outcome: 'FRESH' });
  exporter.shutdown!(); expect(instruments.get('cache_audit_coverage')?.removeCallback).toHaveBeenCalledOnce();
});
it('isolates accidental async observation hooks without growing pending promises', async () => {
  const hook = vi.fn(async () => new Promise<void>(() => {})); const exports: MetricSnapshot[] = [];
  const a = new Aggregator({ export: s => { exports.push(s); }, recordLoaderDuration: hook }, () => 'CLOSED', 10000, 100);
  for (let i = 0; i < 20; i++) a.loader('safe:*', 1);
  expect(hook).toHaveBeenCalledOnce(); await a.shutdown();
  expect(exports[0]?.dropped).toContainEqual({ reason: 'EXPORTER_ERROR', count: 20 });
});
