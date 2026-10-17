# staleprobe

**Observe-only cache staleness detection for Node.js.** Probe your cache. Measure the truth.

`staleprobe` samples cache hits, checks them against an application loader in the background, and measures disagreements. Cache hit rates and Redis latency do not tell you whether a hit contains current data. This SDK adds that signal without repairing your cache or waiting for the loader before returning a hit.

## Install

```sh
npm install staleprobe ioredis
```

Node.js 20+ is required. The package supports ESM, CommonJS and TypeScript. The only mandatory runtime dependency is `@opentelemetry/api`; ioredis is an optional peer. Install published releases from npm, or build a source checkout and install its tarball from `npm pack`. The source repository is [Ragul20070504/staleprobe](https://github.com/Ragul20070504/staleprobe).

## Quick start

```ts
import { createAuditor, createIoredisAdapter } from 'staleprobe';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const auditor = createAuditor({ sampleRate: 0.01 });
const cache = auditor.wrap(createIoredisAdapter(redis), {
  rules: [{
    pattern: 'product:*',
    ttlSeconds: 300,
    loader: async (key, signal) => {
      const response = await fetch(`https://api.example.com/products/${key.slice(8)}`, { signal });
      if (!response.ok) throw new Error('Origin unavailable');
      return response.json();
    },
  }],
});

const cached = await cache.get('product:123');
// At application shutdown:
await auditor.shutdown();
await redis.quit();
```

The loader must return the same logical representation as the cached value. The Redis adapter decodes JSON strings for comparison; it returns the original string to callers. Plain strings remain strings. Use `createIoredisAdapter(redis, {decode})` to supply another decoder. The quick start's HTTP endpoint is illustrative; [the runnable catalog example](example/README.md) uses PostgreSQL.

## Rules and adapters

Rules are evaluated in array order; **first match wins**. Strings are anchored, case-sensitive globs: only `*` is special and matches any sequence. Regex rules use normal JavaScript matching, with `lastIndex` reset on each use. Keep regexes simple; synchronous regex evaluation cannot be timed out. At most 1,000 rules are accepted. `mget` accepts keys or an array, selects each hit independently and leaves misses untouched. Callback overloads bypass auditing. Unrelated client methods retain their context and arguments; transaction/pipeline reads are not intercepted. Chained methods returning the raw client may bypass the wrapper.

For another cache, implement `CacheAdapter<T>` with `client`, read-only `read(key, age, signal)`, `decode(value)` and `isMiss(value)`. Its client must expose promise-based `get` and optionally `mget`. The read result is `{value, pttlMs?}`. Adapters must never mutate the cache or report key/value details through telemetry.

`compare.ignore` accepts RFC 6901 JSON pointers such as `/updatedAt`, `/metadata/requestId`, `/items/0/transient` and `/a~1b`. Object fields are omitted; ignored array slots become null to preserve positions. Arrays treat holes/undefined as null. Undefined object fields are absent. Keys sort recursively. Typed canonical tokens distinguish strings, numbers, booleans, null, undefined, ISO dates, `bigint:<decimal string>` and `buffer:<hex string>`. NaN and infinities have stable numeric tokens; -0 equals 0. Functions, symbols, accessors, invalid dates, class instances, Map/Set and cycles are unsupported. Maximum traversal depth is 100. Oversized inputs return `SKIPPED_TOO_LARGE`; unsupported inputs return `SKIPPED_UNSUPPORTED`.

`compare.fn(a, b)` overrides hash equality after size/support checks. It receives original decoded values, including fields ignored by canonicalization; implement its own ignored-field policy if needed. It must return a boolean synchronously, be pure and fast. Exceptions become `AUDIT_ERROR`; JavaScript cannot preempt synchronous code. Non-transitive comparators can produce surprising race classifications. Default equality is recommended. No complete values enter aggregation records.

## Configuration

All numeric values must be finite; capacities are positive safe integers. Invalid options throw sanitized configuration errors. Operational failures are isolated.

| Option | Default | Meaning |
|---|---:|---|
| `sampleRate` | `.01` | Fraction in [0,1]; rule-level override supported |
| `sampleWindowMs` | `60000` | Positive deterministic sampling window |
| `budget.perSecond` | `20` | Positive token refill rate; initial burst max(1, rate) |
| `budget.maxConcurrent` | `5` | Worker, outstanding loader/read and callback slot limits |
| `budget.queueSize` | `1000` | Pending capacity; full queue drops newest |
| `breaker.errorRate` | `.2` | Loader failure fraction threshold in [0,1] |
| `breaker.p95Ms` | `1500` | Positive nearest-rank latency threshold |
| `breaker.cooldownMs` | `30000` | Wait before one recovery verification |
| `breaker.windowMs` | `60000` | Rolling observation lifetime |
| `breaker.minObservations` | `10` | Minimum before closed-state decisions |
| `breaker.maxObservations` | `100` | Maximum rolling observations, at least minimum |
| `keyPattern` | rule template | Trusted function returning a nonsensitive static label |
| `maxPatterns` | `500` | Distinct labels, plus `__other__` and `__unmatched__` |
| `perKeyCooldownMs` | `30000` | Nonnegative gap per key; 0 disables cooldown |
| `maxCooldownKeys` | `10000` | Bounded digested-key cooldown entries |
| `maxCompareBytes` | `262144` | Limit for each canonical representation |
| `loaderTimeoutMs` | `2000` | Deadline per loader and background adapter read |
| `flushIntervalMs` | `10000` | Periodic metric flush interval |
| `exportTimeoutMs` | `2000` | Deadline per export and exporter shutdown call |
| `exporter` | OTel API | Custom `AuditExporter`, or `false` for no export |
| `onResult` | none | Callback with normalized pattern, result, optional estimated age |

Timers must be positive and no larger than 2,147,483,647 ms. Each rule also accepts a positive `ttlSeconds`. `pause()` stops new scheduling; `resume()` resumes it. Paused reads do not contribute coverage. `shutdown()` cancels queued and active work, flushes, and releases timers; it is idempotent. It does not close your Redis connection or MeterProvider. No new auditing starts after shutdown. Disabled state is captured at construction.

## Sampling and origin protection

SHA-256 of a length-delimited key and `floor(now / sampleWindowMs)` selects one of 10,000 buckets. The same key/window/rate makes the same decision across processes. Choices change probabilistically between windows; no key is guaranteed selection in a particular period. A rule's rate replaces the global rate, including zero. Cooldowns use key digests and evict oldest entries when full; eviction may permit an earlier check. Queue rejection still consumes the cooldown. Per-process budgets/cooldowns are not distributed limits.

Jobs start on a later event-loop turn. Token-bucket admission limits **verifications**, each of which can make two origin calls. Outstanding loader and adapter promises are separately bounded by concurrency, even after timeout. A loader that ignores its AbortSignal keeps a slot until it settles. If all slots are stuck, subsequent checks skip rather than expand work. Callbacks have the same bounded-slot policy; exporters have one slot. Cancellation is cooperative and cannot terminate synchronous code or an already issued Redis command.

The breaker observes loader calls, including errors and timeout latency, over its rolling time/count window. After the minimum sample count, error rate or nearest-rank p95 **strictly above** its threshold opens the circuit. Ordinary work is rejected while open. After cooldown, one recovery verification probes; healthy loader calls close it, failure/slow calls reopen it. Stale results are not errors. Already running checks can finish after opening.

## Race filtering

First compare the original cached value with `fresh1`; equality immediately means `FRESH`. Otherwise wait a cancellable random 50–200 ms, read `cached2` and load `fresh2`:

1. Cache changed since the original hit: `RACE_IN_FLIGHT`.
2. Origin changed since `fresh1`: `ORIGIN_CHANGING`.
3. Second cache and origin agree: `FRESH`.
4. Otherwise: `STALE`.

The checks run in that order with identical comparison semantics. For transitive hash equality the third branch is logically redundant, but it is retained for custom comparison semantics. Races and origin changes are inconclusive, not stale. A non-atomic read can still misclassify a concurrent update; this is an observation, not a linearizability proof.

## Metrics and Grafana

Use an existing MeterProvider with `createOtelExporter({meterProvider})`, or a Meter with `{meter}`. The default uses the global OTel API, which is a no-op until configured. The SDK does not install a provider. See the [official JavaScript metrics exporter documentation](https://opentelemetry.io/docs/languages/js/exporters/) and the [example's Prometheus pipeline](example/README.md).

| Instrument | Type / unit | Attributes |
|---|---|---|
| `cache_audit_checks_total` | Counter / checks | `pattern`, `result` |
| `cache_audit_entry_age_seconds` | Histogram / seconds | `pattern`, `outcome` |
| `cache_audit_loader_duration_seconds` | Histogram / seconds | `pattern` |
| `cache_audit_dropped_total` | Counter / events | `reason` |
| `cache_audit_breaker_state` | Observable gauge / 1 | none; closed=0, open=1, half-open=2 |
| `cache_audit_coverage` | Observable gauge / 1 | none |

Counters flush as deltas every 10 seconds and on shutdown. Histogram hooks record exact measurements as they occur; custom exporters receive bounded non-cumulative histogram bins, counts and sums in snapshots. Ages use boundaries 1, 5, 30, 60, 300, 900, 3600, 21600, 86400 seconds. OTel boundary advice requires a compatible provider; the example sets explicit views. Export failures are counted, with no automatic retries or replay to avoid duplicates. A hanging exporter occupies the one export slot, and aggregation remains bounded. Its final failure may have no subsequent successful flush to report it.

Coverage is configured hits / all hits before sampling, excluding misses, in the latest flush interval; no observations means no gauge observation. `SKIPPED` on `__unmatched__` reveals configuration gaps. Unsampled hits only affect coverage. Drops are separate, and may include isolated instrumentation failures. `onResult` covers executed verification jobs; unmatched keys are aggregated without callbacks, and saturated callback slots can drop events with a counted reason.

**Staleness rate = STALE / (FRESH + STALE).** Exclude races, changing origins, loader failures and skipped checks. An empty denominator means insufficient observations, not 0% stale. The [dashboard](example/grafana/dashboard.json) preserves that distinction and plots counts as well as ratios.

With a configured original TTL, estimated age is `ttlSeconds - PTTL/1000`, only for PTTL between 0 and that TTL. Initial age collection issues PTTL immediately before an additional verification GET; it estimates age at that verification read, not precisely at the original hit. TTL resets, missing keys, unknown/no-expiry TTLs and non-atomic read timing limit interpretation.

## Disable auditing

Set `CACHE_AUDIT_DISABLED=1` before calling `createAuditor`. It returns the original client, creates no audit timers/instruments/work, and never calls loaders or exporters. `exporter: false` only disables export; comparisons still run. Use `pause()` for a temporary scheduling stop.

## Performance

The request continuation matches, samples and enqueues without awaiting loaders, comparison, waits, callbacks, export or worker execution. See [measured benchmark results](docs/benchmarks.md) and `npm run benchmark` for throughput and p50/p95/p99. Sub-50-µs sampled-out overhead is a target, not a guarantee. CPU-heavy comparison still shares the application event loop. Audit only appropriate payload sizes; assess added origin load before raising rates.

## Privacy and observe-only guarantees

SDK audit paths call only GET/PTTL. Tests spy on SET/DEL/EXPIRE/PEXPIRE/FLUSHDB/UNLINK. Application callers can still invoke writes normally through the wrapped client. No raw keys, values, user error messages or stacks are emitted. Default labels come from normalized **configured glob rules**; exact-string and regex rules use numbered labels, unmatched hits use `__unmatched__`, and overflow uses `__other__`. The exported `normalizeKey` helper replaces digit runs, UUIDs, long hex and long opaque segments. Heuristic normalization alone cannot guarantee privacy, so it is not applied directly to arbitrary keys for default telemetry. Different rules may normalize to the same label and merge series; use distinct static labels when that matters. Rule templates and a custom `keyPattern` are trusted: never put secrets in templates or return keys, emails or hashed key IDs.

## Limitations and troubleshooting

This is a new, locally tested SDK, not a production-proven consistency system. Loaders define truth and may read lagging replicas. A slow or broken origin lowers observation coverage. There is no repair, distributed budget, pipeline interception, background retry or persistent audit history. Unsupported inputs skip; synchronous hostile proxies/getters/regexes/custom code cannot be preempted. See [limitations](docs/limitations.md), [architecture](docs/architecture.md), [design decisions](docs/design-decisions.md) and [comparison with related tools](docs/competitive-analysis.md). If metrics are absent, check disabled state, provider setup, rules, sampling, cooldown, drops and the next flush interval.

## Development and example

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run validate:package
npm run benchmark
npm run example:install
```

Then follow [example startup instructions](example/README.md) for Docker Compose, `.env` setup and `npm run example:start`. `REDIS_URL=... npm test` enables the optional real-Redis test against a disposable service; shell syntax varies. CI runs that test with Redis. The package validator installs the packed artifact in a clean temporary project, runs ESM/CommonJS/JavaScript type checks without ioredis, checks README wiring and validates dashboard/Compose configuration. The quick start's placeholder HTTP backend requires your own endpoint.

The **Full Docker demo** CI job also runs real PostgreSQL, Redis, Prometheus and Grafana, verifies stale-cache behavior without cache writes, and captures the dashboard in Chromium. See [full-stack results and reproduction steps](docs/full-stack.md).

## License and contributions

MIT, see [LICENSE](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md) for changes, tests and release guidance. Publishing requires maintainer authorization. Before each release, confirm naming rights and metadata, review the package tarball and run the release checklist.
