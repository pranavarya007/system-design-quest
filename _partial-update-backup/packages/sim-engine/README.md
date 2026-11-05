# @sdq/sim-engine

A small, deterministic discrete-event simulator for teaching system design. It powers every simulation in [System Design Quest](https://pranavarya007.github.io/system-design-quest/), a free, open-source system design course developed and maintained by [Aimbytes](https://www.aimbytes.com/).

- **No dependencies, no framework.** Runs in the browser or Node.
- **Deterministic.** The same config and seed always give the same result. Integer microseconds and a seeded PRNG (mulberry32).
- **Checked against queueing theory.** The test suite compares runs with M/M/1, Erlang C and Little's law.

## What it models

- **Servers:** workers, a bounded queue, exponential, lognormal or fixed service times, failure rates, cost and autoscaling with warm-up.
- **Load balancers:** round robin, least connections, random, hash mod N, consistent hashing, and primary/replicas with replication lag or synchronous replication. Health checks and circuit breakers (optionally half-open).
- **Caches:** Zipf-distributed keys, TTL with jitter, LRU, LFU or random eviction, and request coalescing.
- **Rate limiters:** token bucket, fixed window or sliding window.
- **Message queues:** acknowledgements, redelivery, dead-letter queues, lost acks, duplicates and idempotent consumers.
- **Clients:** timeouts, retries, exponential backoff and jitter.
- **Events:** kill, revive, scale, slow down, fail, purge.

## Use

```ts
import { simulate } from "@sdq/sim-engine";

const result = simulate({
  seed: 1,
  duration_us: 60_000_000,
  nodes: [
    { id: "lb", kind: "lb", algo: "round_robin" },
    { id: "a", kind: "server", workers: 4, queue: Infinity, service: { dist: "exponential", mean_us: 50_000 } },
    { id: "b", kind: "server", workers: 4, queue: Infinity, service: { dist: "exponential", mean_us: 50_000 } },
  ],
  edges: [["lb", "a"], ["lb", "b"]],
  traffic: [[0, 100]],
  events: [{ at_us: 30_000_000, kill: "a" }],
});

console.log(result.summary.p99_us, result.summary.errors);
```

`result` has per-request and per-attempt records, node events and one-second metric windows. `grade(summary, goal)` scores a run against targets, and `runVariants` / `gradeVariants` grade a design on hidden traffic variants.

Results change between minor versions while the version is 0.x. `ENGINE_VERSION` is exported so saved results can say which engine produced them.

## Licence

MIT.
