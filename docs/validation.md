# Validation and release status

## Local and hosted evidence

- The initial repository was empty with no commits or user files. During the initial build, no remote configuration was changed and no commits, push or publication were performed. The maintainer subsequently authorized publication to the connected Ragul20070504 GitHub profile and npm under the confirmed name staleprobe.
- Core Vitest unit/property/lifecycle suite: 59 passing tests; one optional real-Redis test skipped without REDIS_URL. Tests include all verifier branches, deterministic sampling, finite cooldown/pattern state, queue/rate/concurrency behavior, rolling breaker/probe transitions, shutdown, disabled-mode resources and isolation of accidentally async extensions.
- Strict TypeScript and tsup ESM/CommonJS/declaration builds pass.
- Clean consumer validator installs the actual tarball outside the repository, checks ESM/CJS import behavior, JavaScript declaration inference and expected type errors, and proves ioredis is absent until explicitly installed. The exact README quick start type-checks and executes against a module-loader Redis fixture; the HTTP endpoint in that snippet remains illustrative.
- Catalog HTTP test verifies normal cache population and an origin update leaving the cached response unchanged. The metrics test uses the actual OTel MeterProvider and Prometheus reader, checks exported names/labels/boundaries, confirms coverage 0.5 and verifies sensitive key text is absent.
- Dashboard JSON and Compose/Prometheus/Grafana YAML pass local structural validation. GitHub Actions also passed Docker Compose's native validator and real Redis tests on Node 20, 22 and 24: [CI run 39012038895](https://github.com/Ragul20070504/staleprobe/actions/runs/39012038895).
- Root and example npm dependency audits report zero known vulnerabilities at build time. Lockfiles record the installed versions; this is not a guarantee against later advisories.
- `npm pack --dry-run` and the package validator inspect the allowlisted payload, required exports/declarations and absence of environment secrets, tests and node_modules.
- Benchmarks measure three trials of 50,000 samples per path after 5,000 warm-up reads per path. See benchmarks.md and the checked-in raw JSON; numbers are local mock results, not production claims.
- Local source validation: 59 tests passed and one real-Redis test skipped on Node 20.20.2, 22.23.3 and 24.18.0; two example tests passed. Hosted CI then passed with real Redis enabled on Node 20/22/24. No test failures remain. The final Windows/Node 24 run measured sampled-out p50/p95/p99 of 1.4/2.9/6.2 microseconds versus 0.1/0.1/0.1 direct, a p99 overhead of 6.1 microseconds. The release package contains 32 allowlisted files including CHANGELOG.md; the exact dry-run byte size can change with documentation updates.
- The public source is available at https://github.com/Ragul20070504/staleprobe, under the confirmed maintainer profile. The initial source commit is b2d1922.
- staleprobe@0.1.0 is published publicly at https://www.npmjs.com/package/staleprobe with the `latest` tag. A clean consumer successfully ran `npm install staleprobe`, resolved version 0.1.0, imported ESM and CommonJS and completed an asynchronous FRESH verification without ioredis installed. The registry tarball SHA-1 is `1025abacb8f97d037fd5ba9c9ef308e0ba3ef274`, matching the submitted artifact. Source commit d25d7bf is tagged v0.1.0. npm initially exposed a temporary placeholder while processing the upload; verification was repeated after the real version became public.
- The complete Docker demo passed in [CI run 39015176586](https://github.com/Ragul20070504/staleprobe/actions/runs/39015176586): real PostgreSQL and Redis, normal miss/cache-hit flow, deliberate origin-only update, 1 FRESH and 2 STALE checks, zero Redis mutations during auditing, decreasing TTL, Prometheus scraping, all ten Grafana queries and Chromium rendering with actual staleness chart data. See [full-stack evidence](full-stack.md) and the recorded report/screenshot artifact. Containers were stopped after verification.

## Scope and limitations

- A live Redis test in this local Windows environment: no configured disposable Redis URL/server was available. The same real-Redis test did pass in hosted CI.
- Docker is not installed on the original Windows machine. The complete PostgreSQL/Redis/Prometheus/Grafana demo was therefore verified on a hosted Ubuntu Docker runner, not on this workstation.
- The core suite also passed locally with npm-provided Node 20.20.2 and 22.23.3 runtimes; remote GitHub Actions subsequently passed on Node 20/22/24.
- README's illustrative external HTTP backend: it is not a real service. The runnable PostgreSQL example provides the complete application wiring instead.
- Initial npm release metadata: staleprobe@0.1.0, npm maintainer ragul2007, source Ragul20070504/staleprobe. The [npm listing](https://www.npmjs.com/package/staleprobe) is the authoritative publication record. The Docker validation changes add test/development tooling and dashboard refinements; the published SDK remains 0.1.0.

## Self-review refinements and deviations

- Labels default to normalized configured glob templates and numbered exact/regex rules, instead of heuristically normalizing arbitrary keys. This intentionally strengthens the raw-key privacy guarantee. Custom normalizers/templates remain trusted inputs.
- Added `resume()`, explicit timeout/capacity/window options and bounded outstanding-operation slots to resolve lifecycle and cancellation ambiguities. Defaults remain those requested.
- The second FRESH branch is unreachable for a transitive hash equivalence after the earlier equality branches. It remains implemented and tested with a non-transitive custom comparator as specified.
- OTel histogram observations use synchronous hooks because its API cannot ingest aggregated bins. Custom exporters still receive bounded, exact histogram snapshots.
- Shutdown cancels instead of draining. It normally completes after cancellation microtasks and at most three sequential exportTimeoutMs waits (an in-progress flush, final flush and exporter shutdown). Synchronous user code can still block Node's event loop.
- No lint tool was configured; strict type checking, focused behavior tests and the real-service smoke test are the automated checks. The release and hosted results above were executed and verified; no production deployment or adoption is claimed.

The implementation, local checks, hosted CI, complete Docker demo validation and initial public npm release are complete. Operational limitations remain documented in limitations.md; this is not a production-scale reliability claim.
