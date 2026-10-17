import { OperationGate } from './runtime.js';
import { AuditResult, type AuditEvent, type AuditExporter, type Histogram, type MetricSnapshot } from './types.js';
import type { BreakerState } from './breaker.js';
import type { DropReason } from './budget.js';

export const AGE_BOUNDARIES = [1, 5, 30, 60, 300, 900, 3600, 21600, 86400] as const;
export const DURATION_BOUNDARIES = [.005, .01, .025, .05, .1, .25, .5, 1, 2, 5] as const;
function observe(histogram: Histogram, value: number): void {
  const index = histogram.boundaries.findIndex(boundary => value <= boundary);
  histogram.counts[index < 0 ? histogram.boundaries.length : index]!++;
  histogram.count++; histogram.sum += value;
}
function histogram(boundaries: readonly number[]): Histogram {
  return { boundaries, counts: Array<number>(boundaries.length + 1).fill(0), count: 0, sum: 0 };
}

export class Aggregator {
  private checks = new Map<string, MetricSnapshot['checks'][number]>();
  private ages = new Map<string, MetricSnapshot['entryAge'][number]>();
  private durations = new Map<string, MetricSnapshot['loaderDuration'][number]>();
  private dropped = new Map<DropReason, number>();
  private matched = 0;
  private total = 0;
  private readonly gate = new OperationGate(1);
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private hookPending = false;
  constructor(private readonly exporter: AuditExporter, private readonly state: () => BreakerState, intervalMs: number, private readonly timeoutMs: number) {
    this.timer = setInterval(() => { void this.flush(); }, intervalMs); this.timer.unref();
  }
  coverage(matched: boolean): void { this.total++; if (matched) this.matched++; }
  drop(reason: DropReason): void { this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1); }
  private hook(run: () => unknown): void {
    if (this.hookPending) { this.drop('EXPORTER_ERROR'); return; }
    try {
      const result = run();
      // Hooks are synchronous by contract; isolate accidental async implementations too.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        this.hookPending = true;
        this.drop('EXPORTER_ERROR');
        void Promise.resolve(result).catch(() => {}).finally(() => { this.hookPending = false; });
      }
    } catch { this.drop('EXPORTER_ERROR'); }
  }
  record(event: AuditEvent): void {
    const key = JSON.stringify([event.pattern, event.result]);
    const counter = this.checks.get(key) ?? { pattern: event.pattern, result: event.result, count: 0 };
    counter.count++; this.checks.set(key, counter);
    if (event.entryAgeSeconds !== undefined) {
      const series = this.ages.get(key) ?? { pattern: event.pattern, outcome: event.result, histogram: histogram(AGE_BOUNDARIES) };
      observe(series.histogram, event.entryAgeSeconds); this.ages.set(key, series);
      if (this.exporter.recordEntryAge) this.hook(() => this.exporter.recordEntryAge!({ ...event }));
    }
  }
  loader(pattern: string, ms: number): void {
    const series = this.durations.get(pattern) ?? { pattern, histogram: histogram(DURATION_BOUNDARIES) };
    observe(series.histogram, ms / 1000); this.durations.set(pattern, series);
    if (this.exporter.recordLoaderDuration) this.hook(() => this.exporter.recordLoaderDuration!(pattern, ms / 1000));
  }
  private take(): MetricSnapshot {
    const checks = [...this.checks.values()];
    const fresh = checks.filter(c => c.result === AuditResult.FRESH).reduce((sum, c) => sum + c.count, 0);
    const stale = checks.filter(c => c.result === AuditResult.STALE).reduce((sum, c) => sum + c.count, 0);
    const snapshot: MetricSnapshot = {
      checks, entryAge: [...this.ages.values()], loaderDuration: [...this.durations.values()],
      dropped: [...this.dropped].map(([reason, count]) => ({ reason, count })), breakerState: this.state(),
      coverage: { matched: this.matched, total: this.total, ratio: this.total ? this.matched / this.total : null },
      stalenessRate: fresh + stale ? stale / (fresh + stale) : null,
    };
    this.checks = new Map(); this.ages = new Map(); this.durations = new Map(); this.dropped = new Map();
    this.matched = 0; this.total = 0;
    return snapshot;
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    // Keep aggregating while an uncooperative exporter occupies the sole slot.
    if (this.gate.size) return Promise.resolve();
    const snapshot = this.take();
    this.flushing = this.gate.run(() => this.exporter.export(snapshot), this.timeoutMs)
      .catch(() => { this.drop('EXPORTER_ERROR'); })
      .finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.timer = undefined;
    if (this.flushing) await this.flushing;
    await this.flush();
    if (this.exporter.shutdown && !this.gate.size) {
      try { await this.gate.run(() => this.exporter.shutdown!(), this.timeoutMs); } catch { this.drop('EXPORTER_ERROR'); }
    }
  }
}
