# Implementation checklist

- [x] 1. Inspect empty repository; scaffold package and strict TypeScript build.
- [x] 2. Normalizer and bounded pattern labels.
- [x] 3. Deterministic sampling and bounded cooldowns.
- [x] 4. Bounded canonical hashes and comparison.
- [x] 5. Queue, rate budget and rolling breaker.
- [x] 6. Cancellable verifier and race classification.
- [x] 7. Bounded aggregation and OpenTelemetry exporter.
- [x] 8. Read-only Redis adapter and public API.
- [x] 9. Unit, property, lifecycle and safety tests (real Redis test provided, locally skipped).
- [x] 10. Reproducible measured benchmarks.
- [x] 11. Catalog example, injected HTTP/real metrics tests and Compose configuration implemented.
- [x] 12. Dashboard, documentation, CI, clean consumer and package review.

## Release gates not verified locally

- [x] Run real Redis integration against a disposable service in GitHub Actions on Node 20/22/24.
- [ ] Run live Compose/PostgreSQL/Prometheus/Grafana smoke test with Docker.
- [x] Execute local core tests on Node 20/22/24.
- [x] Execute GitHub Actions and inspect remote results: https://github.com/Ragul20070504/staleprobe/actions/runs/39012038895.
- [x] Add real maintainer/repository metadata for Ragul20070504/staleprobe; recheck registry name (404 before initial release).
- [x] Publish staleprobe@0.1.0 and verify `npm install staleprobe` from the public registry, ESM/CJS imports and a background FRESH check.

See [validation.md](validation.md) for exact evidence, deviations and limitations.
