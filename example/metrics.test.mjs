import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAuditor, createIoredisAdapter } from 'staleprobe';
import { createTelemetry } from './telemetry.mjs';

test('OTel Prometheus output matches dashboard names, labels and age buckets', async () => {
  const { reader, provider, exporter } = createTelemetry(0);
  const events = [];
  // Keep OTel observable callbacks alive for one scrape after the final audit flush.
  const { shutdown: _shutdown, ...liveExporter } = exporter;
  const auditor = createAuditor({ sampleRate: 1, perKeyCooldownMs: 0, flushIntervalMs: 10000, exporter: liveExporter, onResult: e => { events.push(e); } });
  const cache = auditor.wrap(createIoredisAdapter({ async get() { return '1'; }, async pttl() { return 7000; } }), {
    rules: [{ pattern: 'product:*', ttlSeconds: 10, loader: async () => 1 }],
  });
  const server = http.createServer((req, res) => reader.getMetricsRequestHandler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await cache.get('product:sensitive'); await cache.get('unconfigured:sensitive');
    for (let i = 0; i < 50 && events.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(events[0].result, 'FRESH');
    await auditor.shutdown();
    const url = `http://127.0.0.1:${server.address().port}/metrics`;
    const text = await (await fetch(url)).text();
    assert.match(text, /cache_audit_checks_total\{[^\n]*pattern="product:\*"[^\n]*result="FRESH"[^\n]*\} 1/);
    assert.match(text, /cache_audit_entry_age_seconds_bucket\{[^\n]*le="5"/);
    assert.match(text, /cache_audit_loader_duration_seconds_bucket/);
    assert.match(text, /cache_audit_breaker_state(?:\{[^\n]*\})? 0/);
    assert.match(text, /cache_audit_coverage(?:\{[^\n]*\})? 0.5/);
    assert.ok(!text.includes('sensitive'));
  } finally {
    await auditor.shutdown(); await exporter.shutdown(); await provider.shutdown();
    await new Promise(resolve => server.close(resolve));
  }
});
