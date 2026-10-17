import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import { chromium } from 'playwright';

const appUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const metricsUrl = `http://127.0.0.1:${process.env.METRICS_PORT ?? 9464}/metrics`;
const prometheusUrl = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const grafanaUrl = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3001';
const grafanaUser = process.env.GRAFANA_USER ?? 'admin';
const grafanaPassword = process.env.GRAFANA_PASSWORD ?? 'admin_dev_only';
const grafanaHeaders = { Authorization: `Basic ${Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString('base64')}` };
const evidence = { startedAt: new Date().toISOString(), checks: {}, panels: [] };
const artifacts = new URL('./artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}
async function until(label, read, accepted, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accepted(value)) return value;
    } catch (error) { lastError = error.message; }
    await sleep(1000);
  }
  throw Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`);
}
async function metrics() {
  const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok); return response.text();
}
function checkCount(text, result) {
  return text.split('\n').filter(line => line.startsWith('cache_audit_checks_total{') && line.includes('pattern="product:*"') && line.includes(`result="${result}"`))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1)), 0);
}
async function query(expression, throughGrafana = false) {
  const base = throughGrafana ? `${grafanaUrl}/api/datasources/proxy/uid/staleprobe-prometheus` : prometheusUrl;
  const response = await json(`${base}/api/v1/query?query=${encodeURIComponent(expression)}`, throughGrafana ? { headers: grafanaHeaders } : {});
  assert.equal(response.status, 'success'); return response.data.result;
}

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', () => {});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
let browser;
let page;
let monitor;
let mutations = 0;
try {
  await until('catalog readiness', () => json(`${appUrl}/health`), value => value.status === 'ok');
  await until('Grafana readiness', () => json(`${grafanaUrl}/api/health`), value => value.database === 'ok');
  await until('Redis readiness', () => redis.ping(), value => value === 'PONG');
  assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
  evidence.checks.servicesHealthy = true;

  // Disposable demo fixture only. The normal application populates Redis on this miss.
  await redis.del('product:1');
  const first = await json(`${appUrl}/products/1`);
  assert.equal(first.source, 'origin');
  const original = first.product;
  const initialTtl = await redis.pttl('product:1');
  assert.ok(initialTtl > 0);
  monitor = await redis.monitor();
  const mutationCommands = new Set(['set', 'del', 'expire', 'pexpire', 'flushdb', 'unlink', 'setex', 'psetex', 'persist']);
  monitor.on('monitor', (_at, args) => { if (mutationCommands.has(args[0]?.toLowerCase())) mutations++; });

  const second = await json(`${appUrl}/products/1`);
  assert.equal(second.source, 'cache'); assert.deepEqual(second.product, original);
  await until('FRESH audit', metrics, value => checkCount(value, 'FRESH') > 0);
  evidence.checks.originThenCache = true;

  const newPrice = Number((original.price + 10).toFixed(2));
  const changed = await json(`${appUrl}/products/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ price: newPrice }),
  });
  assert.equal(changed.cacheUpdated, false); assert.equal(changed.product.price, newPrice);
  assert.equal(Number((await pool.query('SELECT price FROM products WHERE id = 1')).rows[0].price), newPrice);
  const staleHit = await json(`${appUrl}/products/1`);
  assert.equal(staleHit.source, 'cache'); assert.equal(staleHit.product.price, original.price);
  evidence.checks.postgresChangedCacheUnchanged = true;

  // Exercise the documented 30s cooldown; do not shorten production defaults for this test.
  const finalMetrics = await until('STALE audit after cooldown', async () => {
    assert.equal((await json(`${appUrl}/products/1`)).product.price, original.price);
    return metrics();
  }, value => checkCount(value, 'STALE') >= 2, 90_000);
  assert.ok(!finalMetrics.includes('product:1'));
  assert.ok(!finalMetrics.includes(original.name));
  const finalTtl = await redis.pttl('product:1');
  assert.ok(finalTtl > 0 && finalTtl < initialTtl);
  assert.deepEqual(JSON.parse(await redis.get('product:1')), original);
  assert.equal(mutations, 0, 'Audit period must contain no Redis mutation commands');
  evidence.checks.observeOnly = { redisMutations: mutations, initialTtlMs: initialTtl, finalTtlMs: finalTtl };
  evidence.checks.outcomes = { fresh: checkCount(finalMetrics, 'FRESH'), stale: checkCount(finalMetrics, 'STALE') };
  await writeFile(new URL('metrics.txt', artifacts), finalMetrics);

  await until('Prometheus scrape', () => query('up{job="staleprobe-catalog"}'), result => result.some(r => Number(r.value[1]) === 1));
  const staleQuery = 'sum by (pattern) (cache_audit_checks_total{result="STALE"})';
  const expectedStale = checkCount(finalMetrics, 'STALE');
  const staleSeries = await until('Prometheus latest STALE scrape', () => query(staleQuery), result => result.some(r => r.metric.pattern === 'product:*' && Number(r.value[1]) >= expectedStale));
  const ratio = await query('sum by (pattern) (cache_audit_checks_total{result="STALE"}) / sum by (pattern) (cache_audit_checks_total{result=~"FRESH|STALE"})');
  assert.ok(ratio.some(r => r.metric.pattern === 'product:*' && Number(r.value[1]) > 0 && Number(r.value[1]) <= 1));
  evidence.checks.prometheus = { stale: staleSeries, stalenessRate: ratio };

  const dashboard = await until('Grafana provisioning', () => json(`${grafanaUrl}/api/dashboards/uid/staleprobe`, { headers: grafanaHeaders }), value => value.dashboard?.panels?.length === 10);
  const datasource = await json(`${grafanaUrl}/api/datasources/uid/staleprobe-prometheus`, { headers: grafanaHeaders });
  assert.equal(datasource.type, 'prometheus'); assert.equal(datasource.url, 'http://prometheus:9090');
  const proxied = await query(staleQuery, true);
  assert.ok(proxied.some(r => r.metric.pattern === 'product:*' && Number(r.value[1]) > 0));
  for (const panel of dashboard.dashboard.panels) {
    for (const target of panel.targets) {
      const result = await query(target.expr, true);
      if (panel.title === 'Staleness rate by pattern') {
        assert.ok(result.some(r => Number(r.value[1]) > 0), 'Grafana rate panel must have stale data after two observations');
        evidence.checks.grafanaStalenessRate = result;
      }
    }
    evidence.panels.push({ title: panel.title, validQueries: panel.targets.length });
  }
  evidence.checks.grafanaDatasourceAndQueries = true;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1800 } });
  const login = await context.request.post(`${grafanaUrl}/login`, { data: { user: grafanaUser, password: grafanaPassword } });
  assert.ok(login.ok(), 'Grafana browser session login must succeed');
  page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const renderedQuery = page.waitForResponse(response => response.url().includes('/api/ds/query') && response.status() === 200, { timeout: 45000 });
  await page.goto(`${grafanaUrl}${dashboard.meta.url}?from=now-15m&to=now`, { waitUntil: 'domcontentloaded' });
  await renderedQuery;
  for (const panel of dashboard.dashboard.panels) {
    await page.getByText(panel.title, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  }
  assert.equal(browserErrors.length, 0, 'Grafana must render without uncaught browser errors');
  await page.screenshot({ path: fileURLToPath(new URL('grafana.png', artifacts)), fullPage: true });
  evidence.checks.grafanaBrowserRendered = true;
  evidence.completedAt = new Date().toISOString();
  evidence.status = 'passed';
  console.log('Full stack passed: PostgreSQL, Redis, FRESH/STALE audits, read-only cache, Prometheus scrape, 10 Grafana panels and Chromium rendering.');
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.message;
  if (page) await page.screenshot({ path: fileURLToPath(new URL('grafana-failed.png', artifacts)), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(new URL('full-stack.json', artifacts), JSON.stringify(evidence, null, 2) + '\n');
  await browser?.close(); monitor?.disconnect();
  await Promise.allSettled([redis.quit(), pool.end()]);
}
