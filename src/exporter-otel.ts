import { metrics, type Meter, type MeterProvider } from '@opentelemetry/api';
import { AGE_BOUNDARIES, DURATION_BOUNDARIES } from './aggregator.js';
import type { AuditExporter, MetricSnapshot } from './types.js';

export const noopExporter: AuditExporter = Object.freeze({ export() {} });

export function createOtelExporter(options: { meter?: Meter; meterProvider?: MeterProvider } = {}): AuditExporter {
  const meter = options.meter ?? (options.meterProvider ?? metrics).getMeter('staleprobe', '0.1.0');
  const checks = meter.createCounter('cache_audit_checks_total', { description: 'Audit outcomes; only FRESH and STALE are conclusive', unit: '{check}' });
  const age = meter.createHistogram('cache_audit_entry_age_seconds', { description: 'Estimated age using configured original TTL', unit: 's', advice: { explicitBucketBoundaries: [...AGE_BOUNDARIES] } });
  const duration = meter.createHistogram('cache_audit_loader_duration_seconds', { description: 'Loader calls including timeout and failure', unit: 's', advice: { explicitBucketBoundaries: [...DURATION_BOUNDARIES] } });
  const dropped = meter.createCounter('cache_audit_dropped_total', { description: 'Dropped work and isolated instrumentation failures', unit: '{event}' });
  const breaker = meter.createObservableGauge('cache_audit_breaker_state', { description: 'CLOSED=0, OPEN=1, HALF_OPEN=2', unit: '1' });
  const coverage = meter.createObservableGauge('cache_audit_coverage', { description: 'Matched / all cache hits in latest nonempty flush interval; absent when no hits', unit: '1' });
  let current: MetricSnapshot | undefined;
  const breakerCallback: Parameters<typeof breaker.addCallback>[0] = observation => {
    try { if (current) observation.observe({ CLOSED: 0, OPEN: 1, HALF_OPEN: 2 }[current.breakerState]); } catch { /* Provider owns collection errors. */ }
  };
  const coverageCallback: Parameters<typeof coverage.addCallback>[0] = observation => {
    try { if (current?.coverage.ratio != null) observation.observe(current.coverage.ratio); } catch { /* Provider owns collection errors. */ }
  };
  breaker.addCallback(breakerCallback); coverage.addCallback(coverageCallback);
  return {
    export(snapshot) {
      current = snapshot;
      for (const c of snapshot.checks) checks.add(c.count, { pattern: c.pattern, result: c.result });
      for (const d of snapshot.dropped) dropped.add(d.count, { reason: d.reason });
    },
    recordEntryAge(event) { if (event.entryAgeSeconds !== undefined) age.record(event.entryAgeSeconds, { pattern: event.pattern, outcome: event.result }); },
    recordLoaderDuration(pattern, seconds) { duration.record(seconds, { pattern }); },
    shutdown() { breaker.removeCallback(breakerCallback); coverage.removeCallback(coverageCallback); current = undefined; },
  };
}
