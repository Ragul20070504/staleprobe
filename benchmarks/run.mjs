import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { createAuditor, createIoredisAdapter, shouldSample } from '../dist/index.js';

const samples = Number(process.env.BENCH_SAMPLES ?? 50_000);
const warmup = 5000;
const trials = 3;
if (!Number.isSafeInteger(samples) || samples < 1000) throw new Error('BENCH_SAMPLES must be an integer >= 1000');
const tick = () => new Promise(resolve => setImmediate(resolve));
const quantile = (sorted, q) => sorted[Math.ceil(sorted.length * q) - 1];
let key = 'product:0';
for (let i = 0; shouldSample(key, Date.now(), 3_600_000, .01); i++) key = `product:${i + 1}`;

async function measure(mode, count) {
  const client = { async get() { return 'cached'; } };
  let cache = client, auditor;
  let completed = 0, dropped = 0;
  if (mode !== 'direct') {
    const previous = process.env.CACHE_AUDIT_DISABLED;
    if (mode === 'disabled') process.env.CACHE_AUDIT_DISABLED = '1';
    else delete process.env.CACHE_AUDIT_DISABLED;
    auditor = createAuditor({
      sampleRate: mode === 'sampled-out' ? .01 : 1, sampleWindowMs: 3_600_000,
      perKeyCooldownMs: 0, budget: { perSecond: 1_000_000, maxConcurrent: 32, queueSize: 128 },
      exporter: { export(s) { completed += s.checks.reduce((sum, c) => sum + c.count, 0); dropped += s.dropped.reduce((sum, c) => sum + c.count, 0); } },
    });
    if (previous === undefined) delete process.env.CACHE_AUDIT_DISABLED;
    else process.env.CACHE_AUDIT_DISABLED = previous;
    cache = auditor.wrap(createIoredisAdapter(client), { rules: [{ pattern: 'product:*', loader: async () => 'cached' }] });
  }
  const latencies = new Float64Array(count);
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    await cache.get(key);
    latencies[i] = (performance.now() - before) * 1000;
    if (mode === 'enqueued' && i % 16 === 15) await tick();
  }
  const elapsedMs = performance.now() - start;
  if (mode === 'enqueued') for (let i = 0; i < 5; i++) await tick();
  await auditor?.shutdown();
  if (mode === 'sampled-out' && shouldSample(key, Date.now(), 3_600_000, .01)) throw new Error('Sampling window changed; repeat benchmark');
  if (mode === 'enqueued' && (completed !== count || dropped)) throw new Error(`Uncontrolled enqueue benchmark: completed=${completed}, dropped=${dropped}`);
  latencies.sort();
  return { p50Us: quantile(latencies, .5), p95Us: quantile(latencies, .95), p99Us: quantile(latencies, .99), throughputPerSecond: count / (elapsedMs / 1000), completed, dropped };
}
const modes = ['direct', 'disabled', 'sampled-out', 'enqueued'];
for (const mode of modes) await measure(mode, warmup);
const measurements = Object.fromEntries(modes.map(mode => [mode, []]));
for (let trial = 0; trial < trials; trial++) {
  // Rotate order to reduce systematic warm-up/order bias.
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[(i + trial) % modes.length];
    measurements[mode].push(await measure(mode, samples));
  }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(['p50Us', 'p95Us', 'p99Us', 'throughputPerSecond'].map(metric => [metric, median(measurements[mode].map(r => r[metric]))]))]));
for (const mode of modes) {
  results[mode].overhead = Object.fromEntries(['p50Us', 'p95Us', 'p99Us'].map(metric => [metric, { absoluteUs: results[mode][metric] - results.direct[metric], percent: (results[mode][metric] / results.direct[metric] - 1) * 100 }]));
}
const report = {
  measuredAt: new Date().toISOString(), node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30,
  samplesPerTrial: samples, warmupPerMode: warmup, trials, results, measurements,
};
await writeFile(new URL('./results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
const fmt = n => n.toFixed(3);
const rows = modes.map(mode => `| ${mode} | ${fmt(results[mode].p50Us)} | ${fmt(results[mode].p95Us)} | ${fmt(results[mode].p99Us)} | ${Math.round(results[mode].throughputPerSecond)} | ${fmt(results[mode].overhead.p99Us.absoluteUs)} | ${fmt(results[mode].overhead.p99Us.percent)}% |`).join('\n');
const overheadRows = modes.slice(1).map(mode => `| ${mode} | ${['p50Us', 'p95Us', 'p99Us'].map(metric => `${fmt(results[mode].overhead[metric].absoluteUs)} µs / ${fmt(results[mode].overhead[metric].percent)}%`).join(' | ')} |`).join('\n');
await writeFile(new URL('../docs/benchmarks.md', import.meta.url), `# Benchmarks\n\nMeasured ${report.measuredAt}; Node ${report.node}; ${report.platform}; ${report.cpu}; ${report.logicalCpus} logical CPUs; ${fmt(report.memoryGiB)} GiB RAM.\n\nRun \`npm ci && npm run benchmark\`. Optional \`BENCH_SAMPLES\` changes the default ${samples} reads per mode per trial. Each mode warms up for ${warmup} reads, followed by ${trials} trials with rotated order. The table reports medians of each trial statistic, not percentiles of the combined samples. Full observations are in [results.json](../benchmarks/results.json).\n\n| Path | p50 µs | p95 µs | p99 µs | reads/s | p99 overhead µs | p99 overhead % |\n|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\nAll modes use the same promise-returning in-memory mock GET and key. Disabled mode returns the original client. Sampled-out mode uses rate .01 with a deterministically rejected key in a one-hour window. Enqueued mode uses rate 1, zero cooldown, 32 workers and a large rate budget; yields every 16 reads allow audits to finish, and the harness asserts every check completes with zero drops. Individual latency includes the read/continuation; enqueued throughput also includes batch yields and worker execution. Shutdown/export time is excluded.\n\nThe sampled-out p99 overhead target is below 50 µs; this local run ${results['sampled-out'].overhead.p99Us.absoluteUs < 50 ? 'met' : 'did not meet'} that target. This is not a production guarantee. Mock reads, JIT, timer precision, GC, OS scheduling and a single machine limit conclusions; repeat against your cache, keys and payloads. Percentage overhead is inflated by the tiny mock baseline. All work shares the event loop, and large comparisons or custom synchronous code can affect unrelated requests.\n`);
console.log(JSON.stringify({ environment: { node: report.node, cpu: report.cpu }, results }, null, 2));
await writeFile(new URL('../docs/benchmarks.md', import.meta.url), `\nOverhead at each percentile is the difference between the wrapped and direct trial medians, not the percentile of paired latency differences.\n\n| Path | p50 overhead | p95 overhead | p99 overhead |\n|---|---:|---:|---:|\n${overheadRows}\n`, { flag: 'a' });
