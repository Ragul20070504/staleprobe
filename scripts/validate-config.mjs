import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const dashboard = JSON.parse(await read('example/grafana/dashboard.json'));
assert.equal(dashboard.panels.length, 10);
assert.equal(new Set(dashboard.panels.map(p => p.id)).size, 10);
for (const panel of dashboard.panels) {
  assert.ok(panel.title && panel.description && panel.fieldConfig.defaults.unit);
  assert.equal(panel.datasource.uid, 'staleprobe-prometheus');
  for (const target of panel.targets) {
    assert.ok(target.expr.includes('cache_audit_'));
    assert.ok(!/product:\d|user:\d|key=/.test(target.expr));
  }
}
const compose = parse(await read('example/compose.yaml'));
assert.deepEqual(Object.keys(compose.services).sort(), ['grafana', 'postgres', 'prometheus', 'redis']);
for (const service of Object.values(compose.services)) {
  assert.ok(service.image);
  for (const volume of service.volumes ?? []) {
    const relative = volume.split(':')[0];
    assert.ok((await read(`example/${relative}`)).length);
  }
}
const prometheus = parse(await read('example/prometheus.yaml'));
assert.equal(prometheus.scrape_configs[0].static_configs[0].targets[0], 'host.docker.internal:9464');
assert.equal(parse(await read('example/grafana/datasource.yaml')).datasources[0].uid, 'staleprobe-prometheus');
assert.equal(parse(await read('example/grafana/provider.yaml')).providers[0].options.path, '/var/lib/grafana/dashboards');
console.log('Dashboard JSON and YAML service/provisioning configuration validated (live Docker check separate).');
