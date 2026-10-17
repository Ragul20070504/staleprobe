# Product catalog demo

This development-only app uses Express, PostgreSQL, Redis and the locally built staleprobe package. The application populates Redis on misses. Updating PostgreSQL deliberately leaves Redis unchanged; the SDK only reads it.

From the repository root:

```sh
npm ci
npm run build
npm run example:install
docker compose -f example/compose.yaml up -d --wait
```

Copy `example/.env.example` to `example/.env` (`Copy-Item` in PowerShell, `cp` on Unix), then run `npm run example:start`. The demo credentials are public local-development defaults; replace them for any other environment. Database, Redis and dashboard ports bind to loopback. The application and metrics listener bind all interfaces so Docker's Prometheus can scrape the host; use local firewall restrictions and do not expose the demo publicly.

```sh
curl http://localhost:3000/products/1
curl http://localhost:3000/products/1
curl -X PATCH http://localhost:3000/products/1 -H "Content-Type: application/json" -d '{"price":109}'
curl http://localhost:3000/products/1
```

On Windows use `curl.exe` and your shell's JSON quoting, or `Invoke-RestMethod`. First GET populates the cache; second GET is auditable. PATCH changes only PostgreSQL. With the 30-second per-key cooldown, wait at least 31 seconds after a previous audited hit and GET again to observe STALE. Another 10 seconds allows the audit delta to flush; Prometheus scrapes every 5 seconds. A restored price or TTL expiry returns the cache to agreement through normal application behavior.

Metrics: [localhost:9464/metrics](http://localhost:9464/metrics). Prometheus: [localhost:9090](http://localhost:9090). Grafana: [localhost:3001](http://localhost:3001), login `admin` / `admin_dev_only`; the dashboard and Prometheus datasource are provisioned. The OTel Prometheus reader exposes metrics directly, so no Collector is needed. Prometheus in Docker reaches the host via `host.docker.internal`. The dashboard queries correspond to actual OTel API instrument names with no unit suffix translation in this reader configuration.

`npm --prefix example test` verifies the HTTP cache/update flow with injected dependencies. `REDIS_URL` enables the separate core real-Redis test. `docker compose -f example/compose.yaml config` validates Compose with Docker installed. Stop with `docker compose -f example/compose.yaml down`. The SQL initializes only a fresh PostgreSQL data directory.

The pg loader uses a bounded query timeout and checks AbortSignal before and after its query; pg may continue a query after cancellation. SDK outstanding slots remain occupied until it settles. The example is for local demonstrations and intentionally omits authentication and cache invalidation.

## Full-stack smoke test

With the Compose services and app above running, install Chromium once and run:

```sh
npm --prefix example exec -- playwright install --with-deps chromium
npm --prefix example run smoke
```

Use a disposable demo database/cache: this test deletes only the `product:1` fixture before the application populates it, then updates product 1's PostgreSQL price to demonstrate divergence. During auditing it monitors Redis command names and requires zero mutations, verifies decreasing TTL, observes FRESH and two STALE checks using the normal 30-second cooldown, and checks Prometheus scrapes and all ten Grafana panel queries. Chromium loads the actual provisioned dashboard and saves a screenshot. Expect about 70–100 seconds after services are ready.

Evidence is saved under `example/artifacts/`: `full-stack.json`, `metrics.txt` and `grafana.png`. GitHub Actions runs this as the **Full Docker demo** job, uploads the evidence and service logs as the **full-docker-demo** artifact, then stops all containers. This adds no production SDK dependency; Playwright is an example-only development dependency.
