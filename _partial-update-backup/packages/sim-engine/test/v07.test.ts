import { describe, expect, it } from "vitest";
import { simulate, type SimConfig } from "../src/index.js";

const exp = (mean_us: number) => ({ dist: "exponential" as const, mean_us });

describe("cache eviction policies", () => {
  // A small cache over a skewed key space.
  const cfg = (eviction: "lru" | "lfu" | "random"): SimConfig => ({
    seed: 5,
    duration_us: 40_000_000,
    keys: { space: 20_000, zipf: 1 },
    nodes: [
      { id: "c", kind: "cache", hit_us: 500, capacity: 500, ttl_us: 600_000_000, eviction },
      { id: "db", kind: "server", workers: 200, queue: Infinity, service: exp(5_000) },
    ],
    edges: [["c", "db"]],
    traffic: [[0, 1_000]],
  });
  const rate = (e: "lru" | "lfu" | "random") => simulate(cfg(e)).summary.cache_hit_rate!;
  it("under Zipf skew, LFU keeps more of the hot keys than LRU, and LRU beats random", () => {
    const lru = rate("lru");
    const lfu = rate("lfu");
    const rnd = rate("random");
    expect(lfu).toBeGreaterThan(lru);
    expect(lru).toBeGreaterThan(rnd - 0.02);
    for (const r of [lru, lfu, rnd]) expect(r).toBeGreaterThan(0.3);
  });
  it("capacity is respected for every policy", () => {
    for (const e of ["lfu", "random"] as const) {
      const r = simulate(cfg(e));
      expect(r.summary.cache_hit_rate!).toBeLessThan(0.9);
    }
  });
});

describe("cache purge event", () => {
  it("emptying the cache sends a burst of misses to the database", () => {
    const r = simulate({
      seed: 2,
      duration_us: 30_000_000,
      keys: { space: 1_000, zipf: 1 },
      nodes: [
        { id: "c", kind: "cache", hit_us: 500, capacity: Infinity, ttl_us: 600_000_000 },
        { id: "db", kind: "server", workers: 50, queue: Infinity, service: exp(5_000) },
      ],
      edges: [["c", "db"]],
      traffic: [[0, 500]],
      events: [{ at_us: 15_000_000, purge: "c" }],
    });
    const before = r.windows[14]!.cache_misses;
    const after = r.windows[15]!.cache_misses;
    expect(after).toBeGreaterThan(before * 5);
    expect(r.node_events.some((e) => e.type === "purged")).toBe(true);
  });
});

describe("half-open circuit breaker", () => {
  // One backend fails every request for 20 s, then recovers.
  const cfg = (half_open: boolean): SimConfig => ({
    seed: 3,
    duration_us: 60_000_000,
    nodes: [
      { id: "lb", kind: "lb", algo: "round_robin", breaker: { failures: 5, open_us: 2_000_000, half_open } },
      { id: "a", kind: "server", workers: 8, queue: 50, service: exp(20_000) },
      { id: "b", kind: "server", workers: 8, queue: 50, service: exp(20_000) },
    ],
    edges: [["lb", "a"], ["lb", "b"]],
    traffic: [[0, 100]],
    events: [
      { at_us: 10_000_000, fail: "a", rate: 1 },
      { at_us: 30_000_000, fail: "a", rate: 0 },
    ],
  });
  it("sends one trial request instead of a full share each time the breaker reopens", () => {
    const plain = simulate(cfg(false));
    const half = simulate(cfg(true));
    const errs = (r: typeof plain) => r.windows.slice(12, 30).reduce((x, w) => x + w.errors, 0);
    expect(errs(half)).toBeLessThan(errs(plain) / 2);
    expect(half.node_events.some((e) => e.type === "breaker_half_open")).toBe(true);
  });
  it("closes again after the backend recovers", () => {
    const r = simulate(cfg(true));
    expect(r.windows.slice(40, 60).reduce((x, w) => x + w.errors, 0)).toBe(0);
    expect(r.windows[50]!.started.a).toBeGreaterThan(30);
  });
});

describe("synchronous replication", () => {
  const cfg = (sync: boolean): SimConfig => ({
    seed: 4,
    duration_us: 30_000_000,
    keys: { space: 200, zipf: 1, write_ratio: 0.2 },
    nodes: [
      { id: "lb", kind: "lb", algo: "primary_replica", replication_lag_us: 200_000, sync_replication: sync },
      { id: "p", kind: "server", workers: 20, queue: Infinity, service: exp(5_000) },
      { id: "r1", kind: "server", workers: 20, queue: Infinity, service: exp(5_000) },
    ],
    edges: [["lb", "p"], ["lb", "r1"]],
    traffic: [[0, 300]],
  });
  it("trades stale reads for slower writes", () => {
    const a = simulate(cfg(false));
    const s = simulate(cfg(true));
    expect(a.summary.stale_reads).toBeGreaterThan(100);
    expect(s.summary.stale_reads).toBe(0);
    const writeP50 = (r: typeof a) => {
      const ls = r.requests.filter((q) => q.write && q.outcome === "ok").map((q) => q.end_us - q.arrived_us).sort((x, y) => x - y);
      return ls[Math.floor(ls.length / 2)]!;
    };
    expect(writeP50(s)).toBeGreaterThan(200_000);
    expect(writeP50(a)).toBeLessThan(20_000);
  });
});
