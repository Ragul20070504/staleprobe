# Interview handoff

## Problem and lifecycle

A cache hit can be fast and wrong. Hit/miss and operation-latency metrics do not answer whether application data equals the current origin response. staleprobe provides sampled evidence of disagreement, not cache repair or a strong consistency guarantee. See [related approaches](competitive-analysis.md).

`src/index.ts` intercepts promise GET/MGET results, matches the first rule, samples and enqueues. It returns the original value without waiting for verification. `src/budget.ts` starts work on a later turn under a token bucket and concurrency cap. `src/verifier.ts` fingerprints the original value, loads origin data and optionally performs the delayed second-read race filter. Numeric results enter `src/aggregator.ts`; `src/exporter-otel.ts` maps them to counters, exact live histogram observations and gauges. The [architecture diagram](architecture.md) shows the flow.

## Three decisions and alternatives

1. **Retain outstanding-operation slots after timeout.** `OperationGate` in `src/runtime.ts` counts underlying promises, not just Promise.race wrappers. A timeout-only design would repeatedly replace stuck loaders and overload the origin. Tests in `tests/verifier.test.ts` and `tests/integration.test.ts` verify that one stuck slot stays occupied and later work skips.
2. **Canonical type-tagged hashes.** `src/canonical.ts` sorts plain-object keys and streams bounded tokens into SHA-256. Plain JSON would lose BigInt and non-finite distinctions; retaining whole values in history would increase privacy/memory risk. `tests/canonical.test.ts` covers key order, generated records, special types, exact bytes/hash and size rejection. Current trade-offs include Object.keys allocation and inability to preempt synchronous user code.
3. **Explicit inconclusive outcomes.** Cache changes and origin changes become separate outcomes rather than STALE. The alternative, one-read disagreement, is cheaper but prone to concurrent-update false positives. `tests/verifier.test.ts` exercises every state-machine branch, including the second FRESH branch with a non-transitive tolerance comparator.

## Concurrency, cancellation and isolation

The scheduler has one queue, at most maxConcurrent jobs, one rate timer and one scheduled immediate. Separate loader/read/callback gates cap unresolved operations. Export has one gate, and overlapping flushes share a promise. Parent signals abort queued/active work on shutdown. Every async wait has cancellation/deadline handling; no exceptions from loaders, exporters or callbacks enter the original cache request. Shutdown cancels rather than drains, then flushes within configured export deadlines while the event loop remains responsive. Tests cover shutdown before dispatch and during a loader, plus callback/exporter promises that never settle.

## Races, privacy and performance

The first cached=fresh1 comparison wins immediately. Otherwise, after 50–200 ms: cache change wins, then origin change, then second-read equality, otherwise stale. ABA changes and non-atomic observations remain possible. STALE/(FRESH+STALE) excludes all inconclusive results and is null with no eligible observations.

The SDK's Redis adapter only GETs/PTTLs. Mutation spies in `tests/integration.test.ts` verify auditing never writes, while a separate test verifies explicit application writes pass through. Queued/active values are transient; aggregate/event state contains only safe labels, enums and numbers. Default glob labels come from templates, exact/regex rules get numbered labels; trusted custom normalizers must not return secrets.

The measured environment, baseline, trial data and p50/p95/p99/throughput are in [benchmarks.md](benchmarks.md) and [results.json](../benchmarks/results.json). Run `npm run benchmark` to reproduce. Those artifacts contain the actual Node 24.18.0 Windows mock measurements and percentage/absolute overhead. This is local microbenchmark evidence only; large payloads, actual networks and GC change results. Higher scale may need separate auditors per origin, distributed budgets, payload version fields or process-isolated comparison; none is claimed implemented.

## Ten likely questions

1. **Why doesn't a high hit rate prove correctness?** It counts successful cache lookups, not equality with application truth. The loader supplies that missing semantic comparison.
2. **How do you keep audits off the return path?** index schedules a Budget job with setImmediate; `tests/integration.test.ts` asserts the hit has returned while the loader and PTTL have not run.
3. **Why isn't Promise.race enough for timeouts?** It releases a waiter but cannot stop the promise. OperationGate retains the slot until underlying settlement, limiting ignored-cancellation loaders.
4. **What exactly is bounded?** Queue entries, workers, unresolved loader/read/callback promises, export overlap, cooldown digests, normalized labels and histogram bins. Input objects already owned by the application and synchronous user computation cannot be made harmless by an async deadline.
5. **How do you distinguish stale data from a race?** Compare original vs second cache first, origin1 vs origin2 second, then cache2 vs origin2, using the same equality mechanism. `verifier.test.ts` covers all outcomes.
6. **What trips the breaker?** Last 100 calls within 60 seconds, at least ten samples by default; strict error-rate or nearest-rank p95 threshold. One post-cooldown verification probes; failure/slow calls reopen. `budget-breaker.test.ts` covers rolling windows and transitions.
7. **What is the estimate's denominator?** Only FRESH and STALE. Skips, errors, races and changing origins are excluded. `aggregator.test.ts` includes all exclusions and null when empty.
8. **Can a key leak through a hash label?** Yes, hashes remain high-cardinality and potentially identifiable. Digests are only used internally for cooldowns; telemetry uses capped static templates/numbered labels. Exact rule keys are tested for privacy.
9. **What if export fails after partial delivery?** The SDK counts the error and drops that snapshot. It does not replay, because that could double counters. A later successful flush can report the failure; the final failure may remain unexported.
10. **What does the integration evidence establish?** A real hosted Docker run exercised PostgreSQL, Redis, FRESH/STALE classification, zero audit writes, Prometheus scraping, all ten Grafana panel queries and Chromium chart rendering. See full-stack.md and its recorded report. Packed-artifact consumers, ESM/CJS imports, optional peer absence and declarations have separate checks. Production load, clusters and deployment hardening are not established by this demonstration. The original Windows machine still lacks Docker.
