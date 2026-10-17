# Changelog

## 0.1.0

Initial release of staleprobe, observe-only cache staleness detection for Node.js.

- Deterministic sampling, bounded verification budgets and rolling circuit breaker.
- Canonical SHA-256 comparison and explicit cache-race/origin-change outcomes.
- Optional ioredis adapter, OpenTelemetry metrics and failure-isolated callbacks.
- ESM, CommonJS and TypeScript declarations.
- Catalog demo, Grafana dashboard, tests and measured local benchmarks.

This is an initial release with local validation, not a production-proven consistency system. See docs/limitations.md and docs/validation.md for evidence and boundaries.
