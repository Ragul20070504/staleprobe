import { MeterProvider, AggregationType } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { createOtelExporter } from 'staleprobe';

export function createTelemetry(port) {
  const reader = new PrometheusExporter({ port, host: '0.0.0.0', preventServerStart: true });
  const provider = new MeterProvider({ readers: [reader], views: [
    { instrumentName: 'cache_audit_entry_age_seconds', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [1, 5, 30, 60, 300, 900, 3600, 21600, 86400] } } },
    { instrumentName: 'cache_audit_loader_duration_seconds', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [.005, .01, .025, .05, .1, .25, .5, 1, 2, 5] } } },
    { instrumentName: 'cache_audit_checks_total', aggregationCardinalityLimit: 10_000 },
  ] });
  return { reader, provider, exporter: createOtelExporter({ meterProvider: provider }) };
}
