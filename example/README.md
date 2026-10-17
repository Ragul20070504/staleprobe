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
