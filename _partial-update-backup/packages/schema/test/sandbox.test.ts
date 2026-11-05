import { describe, expect, it } from "vitest";
import { simulate } from "@sdq/sim-engine";
import { parseScenarioYaml, toSimConfig } from "../src/index.js";
import {
  PRESETS,
  clone,
  decodeDesign,
  defaultNode,
  emptyDesign,
  encodeDesign,
  toScenario,
  toYaml,
  validate,
  type Design,
  type CacheNode,
  type LbNode,
  type LimiterNode,
  type ServerNode,
} from "../../../apps/web/src/components/sandbox/model";

/** A design that touches every optional field, to catch YAML or conversion drift. */
function kitchenSink(): Design {
  const d = emptyDesign();
  d.title = 'Everything, with "quotes", commas';
  d.nodes = [
    { ...(defaultNode("rate_limiter", "limiter") as LimiterNode), algo: "sliding_window", window_s: 0.5 },
    { ...(defaultNode("cache", "cache") as CacheNode), capacity: -1, ttl_jitter: 0.2, coalesce: true },
    { ...(defaultNode("lb", "lb") as LbNode), algo: "primary_replica", replication_lag_ms: 250, breaker: true },
    { ...(defaultNode("server", "primary") as ServerNode), dist: "p50p99", service_ms: 10, p99_ms: 90, fail_rate: 0.01 },
    { ...(defaultNode("server", "replica") as ServerNode), dist: "fixed", service_ms: 5, queue: -1, autoscale: true, as_min: 1, as_max: 8 },
  ];
  d.edges = [
    ["limiter", "cache"],
    ["cache", "lb"],
    ["lb", "primary"],
    ["lb", "replica"],
  ];
  d.keys = { space: 5000, zipf: 0.9, write_ratio: 0.1 };
  d.client = { timeout_ms: 800, retries: 2, backoff_ms: 50, jitter: true };
  d.traffic = [
    [0, 100],
    [5.5, 200],
  ];
  return d;
}

const designs = [...PRESETS.map((p) => [p.name, p.design] as const), ["empty", emptyDesign()] as const, ["kitchen sink", kitchenSink()] as const];

describe("sandbox", () => {
  for (const [name, d] of designs) {
    it(`${name}: valid, schema-clean, and its YAML gives the same engine config`, () => {
      expect(validate(d).errors).toEqual([]);
      const s = toScenario(d);
      // What the sandbox hands the engine must be what the Zod schema makes of its YAML.
      const fromYaml = parseScenarioYaml(toYaml(d), `${name}.yaml`);
      expect(toSimConfig(fromYaml)).toEqual(toSimConfig(s));
      expect(fromYaml).toEqual(s);
      expect(simulate(toSimConfig(s)).summary.requests).toBeGreaterThan(0);
    });
  }

  it("the URL hash round-trips and rejects junk", () => {
    const d = kitchenSink();
    expect(decodeDesign(encodeDesign(d))).toEqual(d);
    expect(decodeDesign("not base64 json")).toBeNull();
    const junk = decodeDesign(btoa(JSON.stringify({ nodes: [{ kind: "server", id: "x", workers: "lots", dist: "nope" }, { kind: "boom", id: "y" }] })));
    expect(junk?.nodes).toHaveLength(1);
    expect((junk!.nodes[0] as ServerNode).workers).toBe(4);
    expect((junk!.nodes[0] as ServerNode).dist).toBe("mean");
  });

  it("explains wiring mistakes in plain words", () => {
    const d = clone(PRESETS[0]!.design);
    d.edges.push(["server1", "server2"]);
    expect(validate(d).errors.join(" ")).toMatch(/servers can't send anywhere/);
    const two = emptyDesign();
    two.nodes.push(defaultNode("server", "server2"));
    expect(validate(two).errors.join(" ")).toMatch(/2 nodes have nothing pointing at them/);
    const loop = emptyDesign();
    loop.nodes = [defaultNode("cache", "a"), defaultNode("rate_limiter", "b"), defaultNode("lb", "c"), defaultNode("server", "s")];
    loop.edges = [
      ["c", "s"],
      ["a", "b"],
      ["b", "a"],
    ];
    loop.keys.space = 10;
    expect(validate(loop).errors.join(" ")).toMatch(/loop/);
    const big = emptyDesign();
    big.traffic = [[0, 5000]];
    big.duration_s = 120;
    expect(validate(big).errors.join(" ")).toMatch(/requests/);
  });
});
