# Benchmarks

Measured 2026-10-17T06:47:54.410Z; Node v24.18.0; win32 10.0.26200 x64; Intel(R) Core(TM) 3 100U; 8 logical CPUs; 15.649 GiB RAM.

Run `npm ci && npm run benchmark`. Optional `BENCH_SAMPLES` changes the default 50000 reads per mode per trial. Each mode warms up for 5000 reads, followed by 3 trials with rotated order. The table reports medians of each trial statistic, not percentiles of the combined samples. Full observations are in [results.json](../benchmarks/results.json).

| Path | p50 µs | p95 µs | p99 µs | reads/s | p99 overhead µs | p99 overhead % |
|---|---:|---:|---:|---:|---:|---:|
| direct | 0.100 | 0.100 | 0.100 | 7728095 | 0.000 | 0.000% |
| disabled | 0.100 | 0.100 | 0.200 | 7511794 | 0.100 | 100.000% |
| sampled-out | 1.400 | 2.900 | 6.200 | 481111 | 6.100 | 6100.000% |
| enqueued | 0.300 | 0.900 | 3.300 | 31773 | 3.200 | 3200.000% |

All modes use the same promise-returning in-memory mock GET and key. Disabled mode returns the original client. Sampled-out mode uses rate .01 with a deterministically rejected key in a one-hour window. Enqueued mode uses rate 1, zero cooldown, 32 workers and a large rate budget; yields every 16 reads allow audits to finish, and the harness asserts every check completes with zero drops. Individual latency includes the read/continuation; enqueued throughput also includes batch yields and worker execution. Shutdown/export time is excluded.

The sampled-out p99 overhead target is below 50 µs; this local run met that target. This is not a production guarantee. Mock reads, JIT, timer precision, GC, OS scheduling and a single machine limit conclusions; repeat against your cache, keys and payloads. Percentage overhead is inflated by the tiny mock baseline. All work shares the event loop, and large comparisons or custom synchronous code can affect unrelated requests.

Overhead at each percentile is the difference between the wrapped and direct trial medians, not the percentile of paired latency differences.

| Path | p50 overhead | p95 overhead | p99 overhead |
|---|---:|---:|---:|
| disabled | 0.000 µs / 0.000% | 0.000 µs / 0.000% | 0.100 µs / 100.000% |
| sampled-out | 1.300 µs / 1300.000% | 2.800 µs / 2800.000% | 6.100 µs / 6100.000% |
| enqueued | 0.200 µs / 200.000% | 0.800 µs / 800.000% | 3.200 µs / 3200.000% |
