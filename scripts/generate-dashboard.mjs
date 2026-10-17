import { writeFile } from 'node:fs/promises';
const datasource = { type: 'prometheus', uid: 'staleprobe-prometheus' };
const panels = [];
function panel(title, description, exprs, unit = 'short', thresholds = [{ color: 'green', value: null }]) {
  const id = panels.length + 1;
  panels.push({ id, title, description, type: 'timeseries', datasource,
    gridPos: { x: (id - 1) % 2 * 12, y: Math.floor((id - 1) / 2) * 8, w: 12, h: 8 },
    targets: exprs.map(([expr, legendFormat], index) => ({ refId: String.fromCharCode(65 + index), expr, legendFormat, datasource })),
    fieldConfig: { defaults: { unit, ...(unit === 'percentunit' ? { min: 0, max: 1 } : title === 'Circuit breaker' ? { min: 0, max: 2 } : {}), thresholds: { mode: 'absolute', steps: thresholds } }, overrides: [] },
    options: { legend: { displayMode: 'table', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  });
}
const checks = 'cache_audit_checks_total';
const denominator = `sum by (pattern) (rate(${checks}{result=~"FRESH|STALE"}[5m]))`;
// Add a zero-valued denominator series for FRESH-only patterns, but keep empty denominators absent.
panel('Staleness rate by pattern', 'STALE / (FRESH + STALE). No conclusive checks means no data, not 0%.', [[`((sum by (pattern) (rate(${checks}{result="STALE"}[5m])) or (0 * ${denominator})) / ${denominator}) and (${denominator} > 0)`, '{{pattern}}']], 'percentunit', [{ color: 'green', value: null }, { color: 'yellow', value: .01 }, { color: 'red', value: .05 }]);
panel('Fresh and stale checks', 'Conclusive check increases over five minutes.', [[`sum by (pattern, result) (increase(${checks}{result=~"FRESH|STALE"}[5m]))`, '{{pattern}} {{result}}']]);
panel('Loader failures', 'Origin errors and timeouts, excluded from staleness rate.', [[`sum by (pattern) (rate(${checks}{result="LOADER_ERROR"}[5m]))`, '{{pattern}}']], 'ops');
panel('Race and origin changes', 'Inconclusive double reads, excluded from staleness rate.', [[`sum by (pattern, result) (rate(${checks}{result=~"RACE_IN_FLIGHT|ORIGIN_CHANGING"}[5m]))`, '{{pattern}} {{result}}']], 'ops');
panel('Estimated entry age p50 / p95', 'PTTL estimate assumes the configured original TTL. Separate outcomes.', [[`histogram_quantile(0.5, sum by (le, pattern, outcome) (rate(cache_audit_entry_age_seconds_bucket[5m])))`, '{{pattern}} {{outcome}} p50'], [`histogram_quantile(0.95, sum by (le, pattern, outcome) (rate(cache_audit_entry_age_seconds_bucket[5m])))`, '{{pattern}} {{outcome}} p95']], 's');
panel('Loader latency p50 / p95', 'Seconds per loader call, including failures and timeout.', [[`histogram_quantile(0.5, sum by (le, pattern) (rate(cache_audit_loader_duration_seconds_bucket[5m])))`, '{{pattern}} p50'], [`histogram_quantile(0.95, sum by (le, pattern) (rate(cache_audit_loader_duration_seconds_bucket[5m])))`, '{{pattern}} p95']], 's');
panel('Dropped work and isolated failures', 'Queue/breaker/cooldown/cancellation and instrumentation failure reasons.', [['sum by (reason) (rate(cache_audit_dropped_total[5m]))', '{{reason}}']], 'ops');
panel('Circuit breaker', 'CLOSED=0, OPEN=1, HALF_OPEN=2. Latest flushed state per instance.', [['cache_audit_breaker_state', '{{instance}}']], 'short', [{ color: 'green', value: null }, { color: 'red', value: 1 }, { color: 'yellow', value: 2 }]);
panel('Configured-hit coverage', 'Matched / all cache hits before sampling in latest interval; absent when no hits.', [['cache_audit_coverage', '{{instance}}']], 'percentunit', [{ color: 'red', value: null }, { color: 'yellow', value: .8 }, { color: 'green', value: .99 }]);
panel('Skipped checks and audit errors', 'Unconfigured, oversized, unsupported, cancelled and comparison/read failures.', [[`sum by (pattern, result) (rate(${checks}{result=~"SKIPPED.*|AUDIT_ERROR"}[5m]))`, '{{pattern}} {{result}}']], 'ops');
await writeFile(new URL('../example/grafana/dashboard.json', import.meta.url), JSON.stringify({
  uid: 'staleprobe', title: 'staleprobe — cache truth', schemaVersion: 39, version: 1,
  tags: ['cache', 'staleprobe'], timezone: 'browser', refresh: '10s', editable: true,
  time: { from: 'now-1h', to: 'now' }, annotations: { list: [] }, templating: { list: [] }, panels,
}, null, 2) + '\n');
