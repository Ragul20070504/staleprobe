# Contributing

Use Node 20+ (CI covers 20, 22 and 24) and npm. Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `npm run validate:package`. `npm run benchmark` records actual measurements and rewrites docs/benchmarks.md; explain environment differences when updating results. The example has its own lockfile: `npm --prefix example ci && npm --prefix example test`.

Keep strict TypeScript, focused modules and zero extra SDK runtime dependencies. Add focused tests for behavior changes, especially request isolation, privacy, bounded resource use and observe-only operations. Use fake timers for time-dependent tests and fast-check for invariants. Never add raw keys or values to diagnostics, assertions that print production data, telemetry attributes or error messages. A normal application cache write in a test fixture is distinct from an audit write.

PRs should describe the observed problem, changed behavior, trade-offs and validation. Update public option/type documentation with API changes. Do not include unrelated refactors. Conventional commits such as `fix: bound ignored-cancellation loaders` or `feat: add cache adapter` are encouraged.

## Release checklist

1. Run all commands above and `npm audit`; inspect dependency/runtime changes.
2. Run `npm pack --dry-run` and the clean consumer validator (ESM, CJS, JS type checks, optional ioredis absent).
3. Run real Redis tests against a disposable instance with REDIS_URL set. Run the documented Compose demo with a fresh database, observe STALE and verify Grafana queries.
4. Review docs/limitations.md, docs/checklist.md and benchmark evidence. Never relabel an unverified check as passed.
5. Confirm the repository/maintainer URLs, choose a new version, add a changelog entry and recheck npm naming rights/availability. The package's repository is https://github.com/Ragul20070504/staleprobe.
6. Publishing, tagging, pushing and remote configuration changes require explicit maintainer action. Nothing in the build publishes automatically. Use `npm publish --dry-run` before any authorized release.

MIT contributions. By submitting a contribution you agree it can be distributed under the existing MIT license.
