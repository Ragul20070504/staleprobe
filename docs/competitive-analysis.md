# Related approaches

This is a capability comparison, not a claim that the idea is novel or that no alternatives exist. Sources were checked October 17, 2026.

| Approach | What it measures or changes | Relationship to staleprobe |
|---|---|---|
| Redis client-side caching / tracking | Redis tracks reads and sends invalidations on writes to Redis | Prevents a class of local-cache divergence from Redis. It does not, by itself, compare Redis content with a separate application database. See [Redis client-side caching](https://redis.io/docs/latest/develop/clients/client-side-caching/). |
| Redis keyspace notifications | Pub/Sub events for changes in the Redis dataset | Useful input for invalidation logic, but disconnected subscribers can miss events. staleprobe instead samples observed reads and invokes the application's truth loader. See [keyspace notifications](https://redis.io/docs/latest/manual/keyspace-notifications/). |
| OpenTelemetry database metrics | Standard instruments describe database operation duration and related client behavior | Provides the transport and measurement conventions, while staleprobe adds application-defined equality and explicit disagreement outcomes. See [database metrics conventions](https://opentelemetry.io/docs/specs/semconv/db/database-metrics/). |

The specific combination implemented here is observe-only application-level verification, bounded asynchronous work, explicit race/origin-change classification and OTel instruments. These can complement invalidation systems. They do not replace an invalidation strategy or establish strong consistency. There is no evidence yet of production usage, broader market superiority or novelty.
