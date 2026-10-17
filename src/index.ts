import { Aggregator } from './aggregator.js';
import { Breaker, type BreakerOptions } from './breaker.js';
import { Budget, type BudgetOptions } from './budget.js';
import { validateIgnore } from './canonical.js';
import { createOtelExporter, noopExporter } from './exporter-otel.js';
import { normalizeKey, PatternRegistry } from './normalizer.js';
import { callSync, OperationGate } from './runtime.js';
import { Cooldown, shouldSample, validateRate } from './sampler.js';
import { AuditResult, type AuditRule, type Auditor, type AuditorOptions, type CacheAdapter } from './types.js';
import { verify } from './verifier.js';

export { normalizeKey } from './normalizer.js';
export { shouldSample } from './sampler.js';
export { fingerprint, CanonicalError, type Fingerprint } from './canonical.js';
export { createOtelExporter, noopExporter } from './exporter-otel.js';
export { createIoredisAdapter, type RedisReadClient } from './adapter-ioredis.js';
export { AuditResult } from './types.js';
export type * from './types.js';
export type { ComparisonOptions } from './compare.js';
export type { BreakerOptions, BreakerState } from './breaker.js';
export type { BudgetOptions, DropReason } from './budget.js';

function positive(value: number, name: string, integer = false, zero = false): number {
  if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0) || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function timerValue(value: number, name: string): number {
  positive(value, name);
  if (value > 2_147_483_647) throw new Error(`Invalid ${name}`);
  return value;
}
interface CompiledRule { rule: AuditRule; matches: (key: string) => boolean; label: string }
function compileRules(rules: readonly AuditRule[]): CompiledRule[] {
  if (!Array.isArray(rules) || rules.length > 1000) throw new Error('Invalid audit rules');
  return rules.map((input, index) => {
    if (!input || typeof input.loader !== 'function') throw new Error('Invalid audit loader');
    if (input.sampleRate !== undefined) validateRate(input.sampleRate);
    if (input.ttlSeconds !== undefined) positive(input.ttlSeconds, 'TTL');
    if (input.compare?.ignore) validateIgnore(input.compare.ignore);
    if (input.compare?.fn !== undefined && typeof input.compare.fn !== 'function') throw new Error('Invalid comparison function');
    const rule: AuditRule = { ...input, ...(input.compare ? { compare: { ...input.compare, ...(input.compare.ignore ? { ignore: [...input.compare.ignore] } : {}) } } : {}) };
    let regex: RegExp;
    let label: string;
    if (typeof rule.pattern === 'string') {
      if (!rule.pattern.length || rule.pattern.length > 200) throw new Error('Invalid audit pattern');
      regex = new RegExp(`^${rule.pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      label = rule.pattern.includes('*') ? normalizeKey(rule.pattern) : `__rule_${index + 1}__`;
    } else if (rule.pattern instanceof RegExp && rule.pattern.source.length <= 1000) {
      regex = new RegExp(rule.pattern.source, rule.pattern.flags); label = `__rule_${index + 1}__`;
    } else throw new Error('Invalid audit pattern');
    return { rule, label, matches(key) { regex.lastIndex = 0; return regex.test(key); } };
  });
}

export function createAuditor(options: AuditorOptions = {}): Auditor {
  const sampleRate = options.sampleRate ?? .01; validateRate(sampleRate);
  const sampleWindowMs = positive(options.sampleWindowMs ?? 60_000, 'sample window');
  const budgetOptions: BudgetOptions = { perSecond: 20, maxConcurrent: 5, queueSize: 1000, ...options.budget };
  positive(budgetOptions.perSecond, 'rate budget');
  positive(budgetOptions.maxConcurrent, 'concurrency', true); positive(budgetOptions.queueSize, 'queue size', true);
  const breakerOptions: BreakerOptions = { errorRate: .2, p95Ms: 1500, cooldownMs: 30_000, windowMs: 60_000, minObservations: 10, maxObservations: 100, ...options.breaker };
  validateRate(breakerOptions.errorRate); positive(breakerOptions.p95Ms, 'breaker latency');
  positive(breakerOptions.cooldownMs, 'breaker cooldown'); positive(breakerOptions.windowMs, 'breaker window');
  positive(breakerOptions.minObservations, 'minimum observations', true); positive(breakerOptions.maxObservations, 'maximum observations', true);
  if (breakerOptions.minObservations > breakerOptions.maxObservations) throw new Error('Invalid breaker observations');
  const maxPatterns = positive(options.maxPatterns ?? 500, 'pattern capacity', true);
  const maxBytes = positive(options.maxCompareBytes ?? 262_144, 'comparison size', true);
  const timeoutMs = timerValue(options.loaderTimeoutMs ?? 2000, 'loader timeout');
  const exportTimeoutMs = timerValue(options.exportTimeoutMs ?? 2000, 'export timeout');
  const flushIntervalMs = timerValue(options.flushIntervalMs ?? 10_000, 'flush interval');
  const cooldownMs = positive(options.perKeyCooldownMs ?? 30_000, 'key cooldown', false, true);
  const maxCooldownKeys = positive(options.maxCooldownKeys ?? 10_000, 'cooldown capacity', true);
  if (options.keyPattern !== undefined && typeof options.keyPattern !== 'function') throw new Error('Invalid key normalizer');
  if (options.onResult !== undefined && typeof options.onResult !== 'function') throw new Error('Invalid result callback');
  if (options.exporter && typeof options.exporter.export !== 'function') throw new Error('Invalid audit exporter');
  const disabled = process.env.CACHE_AUDIT_DISABLED === '1';
  if (disabled) return { wrap: adapter => adapter.client, pause() {}, resume() {}, async shutdown() {} };
  let paused = false, stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  const breaker = new Breaker(breakerOptions);
  let exporter = options.exporter === false ? noopExporter : options.exporter;
  let exporterFailed = false;
  if (!exporter) {
    try { exporter = createOtelExporter(); } catch { exporter = noopExporter; exporterFailed = true; }
  }
  const aggregator = new Aggregator(exporter, () => breaker.state, flushIntervalMs, exportTimeoutMs);
  if (exporterFailed) aggregator.drop('EXPORTER_ERROR');
  const budget = new Budget(budgetOptions, reason => aggregator.drop(reason));
  const cooldown = new Cooldown(cooldownMs, maxCooldownKeys);
  const registry = new PatternRegistry(maxPatterns, key => key);
  const loaderGate = new OperationGate(budgetOptions.maxConcurrent);
  const readGate = new OperationGate(budgetOptions.maxConcurrent);
  const callbackGate = new OperationGate(budgetOptions.maxConcurrent);
  const active = new Set<Promise<void>>();

  function schedule(adapter: CacheAdapter, rules: CompiledRule[], key: string, value: unknown): void {
    if (stopped || paused) return;
    const miss = callSync(adapter.isMiss, adapter, value);
    if (typeof miss !== 'boolean') throw new Error('Invalid miss predicate');
    if (miss) return;
    const selected = rules.find(rule => rule.matches(key));
    aggregator.coverage(!!selected);
    if (!selected) { aggregator.record({ pattern: '__unmatched__', result: AuditResult.SKIPPED }); return; }
    const now = Date.now();
    if (!shouldSample(key, now, sampleWindowMs, selected.rule.sampleRate ?? sampleRate)) return;
    if (!breaker.canSchedule()) { aggregator.drop('BREAKER_OPEN'); return; }
    if (!cooldown.accept(key, now)) { aggregator.drop('COOLDOWN'); return; }
    let pattern: string;
    try {
      const label = options.keyPattern ? callSync(options.keyPattern, options, key) : selected.label;
      if (typeof label !== 'string') throw new Error('Invalid normalized pattern');
      pattern = registry.label(label);
    }
    catch { aggregator.drop('NORMALIZER_ERROR'); return; }
    budget.enqueue(signal => {
      const work = (async () => {
        const permit = breaker.acquire();
        if (!permit) { aggregator.drop('BREAKER_OPEN'); return; }
        let healthy = true, loaderCalls = 0;
        const event = await verify(adapter, key, value, selected.rule, signal, pattern, {
          loaderGate, readGate, timeoutMs, maxBytes,
          observeLoader(failed, ms) { loaderCalls++; healthy &&= !failed && ms <= breakerOptions.p95Ms; breaker.observe(failed, ms); aggregator.loader(pattern, ms); },
          drop: reason => aggregator.drop(reason),
        });
        breaker.finish(permit, healthy && loaderCalls > 0 && event.result !== AuditResult.AUDIT_ERROR && event.result !== AuditResult.SKIPPED);
        aggregator.record(event);
        if (options.onResult && !signal.aborted) {
          try { await callbackGate.run(() => options.onResult!({ ...event }), timeoutMs, signal); }
          catch { aggregator.drop('CALLBACK_ERROR'); }
        }
      })();
      active.add(work);
      return work.finally(() => { active.delete(work); });
    });
  }
  return {
    wrap<T extends object>(adapter: CacheAdapter<T>, { rules }: { rules: readonly AuditRule[] }): T {
      const compiled = compileRules(rules);
      if (!adapter || typeof adapter.read !== 'function' || typeof adapter.decode !== 'function' || typeof adapter.isMiss !== 'function') throw new Error('Invalid cache adapter');
      const intercept = new Map<string, unknown>();
      return new Proxy(adapter.client, {
        get(target, property) {
          const original: unknown = Reflect.get(target, property, target);
          if (typeof original !== 'function') return original;
          if (property !== 'get' && property !== 'mget') return original.bind(target);
          if (!intercept.has(property)) intercept.set(property, (...args: unknown[]) => {
            const result: unknown = Reflect.apply(original, target, args);
            if (stopped || paused || args.some(arg => typeof arg === 'function')) return result;
            return Promise.resolve(result).then(value => {
              try {
                const keys = property === 'get' ? [args[0]] : args.flat(1);
                const values = property === 'get' ? [value] : value;
                if (Array.isArray(values)) for (let i = 0; i < keys.length; i++) {
                  if (typeof keys[i] === 'string') schedule(adapter, compiled, keys[i] as string, values[i]);
                }
              } catch { aggregator.drop('ADAPTER_ERROR'); }
              return value;
            });
          });
          return intercept.get(property);
        },
      });
    },
    pause() { paused = true; },
    resume() { if (!stopped) paused = false; },
    shutdown() {
      shutdownPromise ??= (async () => {
        stopped = true; budget.shutdown(); cooldown.clear();
        await Promise.allSettled([...active]);
        await aggregator.shutdown();
      })().catch(() => { aggregator.drop('AUDIT_ERROR'); });
      return shutdownPromise;
    },
  };
}
