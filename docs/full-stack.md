# Full Docker demo verification

Verified on October 17, 2026 in GitHub Actions using an Ubuntu runner with Docker and Node 24. Docker remains unavailable on the original Windows workstation; this evidence is from the hosted runner.

- [Successful complete CI run](https://github.com/Ragul20070504/staleprobe/actions/runs/39015176586), tested commit `36a5e58`.
- [Full Docker demo artifact](https://github.com/Ragul20070504/staleprobe/actions/runs/39015176586/artifacts/12094715972): Grafana screenshot, metrics, structured report, service status and logs.
- [Recorded structured report](evidence/full-stack.json).

The actual services were PostgreSQL `17-alpine`, Redis `7-alpine`, Prometheus `v3.5.0` and Grafana `12.1.0`, using the checked-in Compose configuration. The application used the PostgreSQL loader and real Redis reads. No mock database, cache or metrics backend was substituted.

## Results

1. The initial application GET loaded PostgreSQL and populated Redis; the next GET returned the cached response.
2. Updating PostgreSQL left the existing Redis response unchanged, as intended for the demo.
3. Auditing produced **1 FRESH and 2 STALE results**, keeping the ordinary 30-second per-key cooldown.
4. Redis MONITOR observed **zero mutation commands during auditing**. The cached product stayed unchanged and PTTL decreased from 299999 ms to 230829 ms.
5. Prometheus scraped the application, collected both STALE observations and reported the cumulative conclusive-result ratio `2 / 3`.
6. Grafana provisioned the Prometheus datasource and all ten dashboard panels. Every panel expression succeeded through Grafana's datasource proxy.
7. Chromium loaded the actual dashboard, observed a positive data point in the staleness-rate chart response and captured the rendered dashboard without uncaught browser errors.
8. The workflow collected evidence and stopped the application and containers. The Node 20/22/24 SDK checks also passed in the same run.

The Grafana chart uses a rolling five-minute **rate**, while the report also records the cumulative **count** ratio; these can differ during a short startup demonstration. Error/race/skipped panels can display no data because this scenario deliberately generates only fresh/stale results. Histogram quantiles interpolate the configured buckets rather than reporting exact individual ages.

The first new test attempt found that the SDK flush could precede the Prometheus scrape. The test now waits for the scraped counter to match the SDK's latest counter. Visual review also caught a screenshot taken before Grafana's next refresh; the browser test now waits for actual chart data. Neither fix changes the published SDK's behavior.

## Reproduce

Follow [example startup instructions](../example/README.md) on a machine with Docker, then run:

```sh
npm --prefix example exec -- playwright install --with-deps chromium
npm --prefix example run smoke
```

Use a disposable demo database/cache. The test initializes the `product:1` fixture and updates its PostgreSQL price. Results and a screenshot are written to `example/artifacts/`. The workflow runs this automatically as **Full Docker demo** on pushes and pull requests.

This verifies the runnable demonstration and integrations, not production-scale load or a strong consistency guarantee. The npm SDK remains version `0.1.0`; no new npm release was needed for these verification and dashboard improvements.
