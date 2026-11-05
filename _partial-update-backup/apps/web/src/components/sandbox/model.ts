/**
 * Sandbox model: a free design the learner builds from the engine's node kinds, kept in friendly
 * units (seconds, milliseconds, shares), plus validation, conversion to a Scenario, scenario YAML
 * and the URL-hash encoding. No React and no Zod, so it is cheap in the browser and testable.
 */
import type { Scenario } from "@sdq/schema";

export type Kind = "lb" | "server" | "cache" | "rate_limiter" | "queue";
export type LbAlgo = "round_robin" | "least_connections" | "random" | "key_hash" | "consistent_hash" | "primary_replica";
export type LimitAlgo = "token_bucket" | "fixed_window" | "sliding_window";
export type Dist = "mean" | "p50p99" | "fixed";

export interface LbNode {
  id: string;
  kind: "lb";
  algo: LbAlgo;
  health_check_s: number;
  /** primary_replica only. */
  replication_lag_ms: number;
  breaker: boolean;
  breaker_failures: number;
  breaker_open_s: number;
}
export interface ServerNode {
  id: string;
  kind: "server";
  workers: number;
  /** -1 = unbounded. */
  queue: number;
  dist: Dist;
  /** Mean, p50 or fixed time, by dist. */
  service_ms: number;
  /** p50p99 only. */
  p99_ms: number;
  fail_rate: number;
  idempotent: boolean;
  ack_loss_rate: number;
  autoscale: boolean;
  as_min: number;
  as_max: number;
  as_target: number;
  as_check_s: number;
  as_warmup_s: number;
}
export interface CacheNode {
  id: string;
  kind: "cache";
  hit_ms: number;
  /** -1 = unbounded. */
  capacity: number;
  ttl_s: number;
  ttl_jitter: number;
  coalesce: boolean;
}
export interface LimiterNode {
  id: string;
  kind: "rate_limiter";
  algo: LimitAlgo;
  rate_rps: number;
  burst: number;
  window_s: number;
}
export interface QueueNode {
  id: string;
  kind: "queue";
  ack_ms: number;
  /** -1 = unbounded. */
  capacity: number;
  max_deliveries: number;
  redeliver_s: number;
}
export type SbNode = LbNode | ServerNode | CacheNode | LimiterNode | QueueNode;

export interface Design {
  v: 1;
  title: string;
  seed: number;
  duration_s: number;
  nodes: SbNode[];
  edges: [string, string][];
  /** [start second, requests per second] */
  traffic: [number, number][];
  keys: { space: number; zipf: number; write_ratio: number };
  /** timeout_ms 0 = the client waits forever. */
  client: { timeout_ms: number; retries: number; backoff_ms: number; jitter: boolean };
}

export const KIND_NAME: Record<Kind, string> = {
  lb: "Load balancer",
  server: "Server",
  cache: "Cache",
  rate_limiter: "Rate limiter",
  queue: "Queue",
};
const ID_PREFIX: Record<Kind, string> = { lb: "lb", server: "server", cache: "cache", rate_limiter: "limiter", queue: "queue" };

export const LIMITS = { nodes: 16, steps: 12, duration_s: 120, rps: 5_000, requests: 100_000 } as const;
const ID_RE = /^[a-z][a-z0-9_-]*$/;

export function defaultNode(kind: Kind, id: string): SbNode {
  switch (kind) {
    case "lb":
      return { id, kind, algo: "round_robin", health_check_s: 2, replication_lag_ms: 200, breaker: false, breaker_failures: 5, breaker_open_s: 5 };
    case "server":
      return {
        id,
        kind,
        workers: 4,
        queue: 100,
        dist: "mean",
        service_ms: 50,
        p99_ms: 250,
        fail_rate: 0,
        idempotent: false,
        ack_loss_rate: 0,
        autoscale: false,
        as_min: 2,
        as_max: 16,
        as_target: 0.6,
        as_check_s: 5,
        as_warmup_s: 10,
      };
    case "cache":
      return { id, kind, hit_ms: 1, capacity: 1000, ttl_s: 30, ttl_jitter: 0, coalesce: false };
    case "rate_limiter":
      return { id, kind, algo: "token_bucket", rate_rps: 100, burst: 20, window_s: 1 };
    case "queue":
      return { id, kind, ack_ms: 2, capacity: -1, max_deliveries: 3, redeliver_s: 1 };
  }
}

export function freshId(kind: Kind, nodes: SbNode[]): string {
  const taken = new Set(nodes.map((n) => n.id));
  const p = ID_PREFIX[kind];
  if (!taken.has(p) && kind !== "server") return p;
  for (let i = 1; ; i++) if (!taken.has(`${p}${i}`)) return `${p}${i}`;
}

const baseDesign = (title: string): Omit<Design, "nodes" | "edges" | "traffic"> => ({
  v: 1,
  title,
  seed: 1,
  duration_s: 30,
  keys: { space: 10_000, zipf: 1, write_ratio: 0 },
  client: { timeout_ms: 0, retries: 0, backoff_ms: 100, jitter: false },
});

const server = (id: string, over: Partial<ServerNode> = {}) => ({ ...(defaultNode("server", id) as ServerNode), ...over });

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  design: Design;
}

export const PRESETS: Preset[] = [
  {
    id: "lb-three",
    name: "Load balancer and 3 servers",
    blurb: "Round robin over three servers. Traffic climbs to 75% of their capacity at 10 s.",
    design: {
      ...baseDesign("Load balancer and 3 servers"),
      nodes: [defaultNode("lb", "lb"), server("server1"), server("server2"), server("server3")],
      edges: [
        ["lb", "server1"],
        ["lb", "server2"],
        ["lb", "server3"],
      ],
      traffic: [
        [0, 100],
        [10, 180],
      ],
    },
  },
  {
    id: "cache-db",
    name: "Cache in front of a database",
    blurb: "A cache with a 30 s TTL answers hot keys; misses go to a database with a long tail.",
    design: {
      ...baseDesign("Cache in front of a database"),
      nodes: [
        { ...(defaultNode("cache", "cache") as CacheNode), capacity: 2000 },
        server("db", { workers: 8, queue: 200, dist: "p50p99", service_ms: 20, p99_ms: 150 }),
      ],
      edges: [["cache", "db"]],
      traffic: [[0, 600]],
    },
  },
  {
    id: "queue-workers",
    name: "Queue and workers",
    blurb: "A 20 s burst above what two workers can process. Watch the backlog build, then drain.",
    design: {
      ...baseDesign("Queue and workers"),
      duration_s: 50,
      nodes: [defaultNode("queue", "queue"), server("worker1", { queue: 0, service_ms: 100 }), server("worker2", { queue: 0, service_ms: 100 })],
      edges: [
        ["queue", "worker1"],
        ["queue", "worker2"],
      ],
      traffic: [
        [0, 50],
        [10, 110],
        [30, 40],
      ],
    },
  },
];

export const emptyDesign = (): Design => ({ ...baseDesign("My design"), nodes: [server("server1")], edges: [], traffic: [[0, 50]] });

export const clone = (d: Design): Design => JSON.parse(JSON.stringify(d)) as Design;

// ---------- Graph helpers ----------

export const outgoing = (d: Design, id: string) => d.edges.filter(([a]) => a === id).map(([, b]) => b);
export const incoming = (d: Design, id: string) => d.edges.filter(([, b]) => b === id).map(([a]) => a);
export const entries = (d: Design) => d.nodes.filter((n) => !d.edges.some(([, b]) => b === n.id)).map((n) => n.id);

/** Can `from` reach `to` following edges? */
export function reaches(d: Design, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === to) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...outgoing(d, c));
  }
  return false;
}

/** Nodes `id` could send to next, and why not when it can't. */
export function connectTargets(d: Design, id: string): { targets: string[]; reason?: string } {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) return { targets: [] };
  if (n.kind === "server") return { targets: [], reason: "A server is the end of the line: it does the work and answers, so it can't send anywhere." };
  const outs = outgoing(d, id);
  if ((n.kind === "cache" || n.kind === "rate_limiter") && outs.length >= 1)
    return { targets: [], reason: `A ${KIND_NAME[n.kind].toLowerCase()} sends to exactly one node. Disconnect ${outs[0]} first to choose another.` };
  const targets = d.nodes
    .filter((t) => t.id !== id && !outs.includes(t.id))
    .filter((t) => (n.kind === "lb" || n.kind === "queue" ? t.kind === "server" : true))
    .filter((t) => !reaches(d, t.id, id))
    .map((t) => t.id);
  return { targets, reason: targets.length ? undefined : n.kind === "lb" || n.kind === "queue" ? "Add a server for it to send to." : "Add another node for it to send to." };
}

export const needsKeys = (d: Design) => d.nodes.some((n) => n.kind === "cache" || (n.kind === "lb" && ["key_hash", "consistent_hash", "primary_replica"].includes(n.algo)));

// ---------- Validation ----------

export interface Problems {
  errors: string[];
  warnings: string[];
}

export function validate(d: Design): Problems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const bad = (cond: boolean, msg: string) => cond && errors.push(msg);
  const num = (v: number, lo: number, hi: number, msg: string, int = false) => bad(!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)), msg);

  if (d.nodes.length === 0) errors.push("Add at least one node. A single server is enough to start.");
  if (d.nodes.length > LIMITS.nodes) errors.push(`Keep it to ${LIMITS.nodes} nodes or fewer so it draws and runs well on a phone.`);
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (!ID_RE.test(n.id)) errors.push(`The name "${n.id}" won't work: start with a lowercase letter and use only lowercase letters, digits, - and _.`);
    if (ids.has(n.id)) errors.push(`Two nodes are called ${n.id}. Give each node its own name.`);
    ids.add(n.id);
  }
  const seenEdges = new Set<string>();
  for (const [a, b] of d.edges) {
    if (!ids.has(a) || !ids.has(b)) errors.push(`A connection from ${a} to ${b} names a node that doesn't exist.`);
    if (a === b) errors.push(`${a} is connected to itself.`);
    if (seenEdges.has(`${a}>${b}`)) errors.push(`${a} is connected to ${b} twice.`);
    seenEdges.add(`${a}>${b}`);
  }
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  for (const n of d.nodes) {
    const outs = outgoing(d, n.id);
    const name = `${KIND_NAME[n.kind]} ${n.id}`;
    if (n.kind === "server" && outs.length) errors.push(`Server ${n.id} sends to ${outs.join(", ")}, but servers can't send anywhere. Put a load balancer or queue in front instead.`);
    if ((n.kind === "cache" || n.kind === "rate_limiter") && outs.length !== 1)
      errors.push(outs.length === 0 ? `${name} needs to send to one node: what does it pass requests on to?` : `${name} sends to ${outs.length} nodes; it can only send to one.`);
    if (n.kind === "lb" && outs.length === 0) errors.push(`${name} has no servers to send requests to. Connect it to at least one server.`);
    if (n.kind === "queue" && outs.length === 0) errors.push(`${name} has no workers. Connect it to at least one server that takes messages from it.`);
    if (n.kind === "lb" || n.kind === "queue")
      for (const b of outs) if (byId.get(b) && byId.get(b)!.kind !== "server") errors.push(`${name} can only send to servers, but it's connected to ${KIND_NAME[byId.get(b)!.kind].toLowerCase()} ${b}.`);
    if (n.kind === "lb" && n.algo === "primary_replica" && outs.length < 2)
      errors.push(`${name} uses primary and replicas, so it needs at least two servers: the first one connected is the primary, the rest are replicas.`);
    if (n.kind === "queue") for (const b of outs) if ((byId.get(b) as ServerNode | undefined)?.queue !== 0) warnings.push(`Worker ${b} has its own queue, so messages wait there instead of in ${n.id}. Set its queue to 0 to see the backlog in the queue.`);
  }
  if (d.nodes.length) {
    const ent = entries(d);
    if (ent.length === 0) errors.push("Every node has something pointing at it, so there's a loop and nowhere for traffic to enter. Remove a connection to break the loop.");
    else if (ent.length > 1)
      errors.push(`Traffic enters at the one node nothing points at, but ${ent.length} nodes have nothing pointing at them: ${ent.join(", ")}. Connect them into one design or remove the extras.`);
    else if (d.edges.some(([a, b]) => a !== b && reaches(d, b, a))) errors.push("There's a loop in the connections. Requests would go round forever, so remove one connection.");
  }

  for (const n of d.nodes) {
    const w = (what: string) => `${KIND_NAME[n.kind]} ${n.id}: ${what}`;
    switch (n.kind) {
      case "lb":
        num(n.health_check_s, 0, 60, w("health check every 0 to 60 seconds."));
        if (n.algo === "primary_replica") num(n.replication_lag_ms, 0, 60_000, w("replication lag between 0 and 60,000 ms."));
        if (n.breaker) {
          num(n.breaker_failures, 1, 100, w("the breaker opens after 1 to 100 failures in a row."), true);
          num(n.breaker_open_s, 0.1, 120, w("the breaker stays open 0.1 to 120 seconds."));
        }
        break;
      case "server":
        num(n.workers, 1, 256, w("workers must be a whole number from 1 to 256."), true);
        bad(n.queue !== -1 && (!Number.isInteger(n.queue) || n.queue < 0 || n.queue > 100_000), w("queue must be a whole number from 0 to 100,000, or unbounded."));
        num(n.service_ms, 0.01, 60_000, w(`${n.dist === "p50p99" ? "p50" : n.dist === "fixed" ? "fixed" : "mean"} service time must be between 0.01 and 60,000 ms.`));
        if (n.dist === "p50p99") {
          num(n.p99_ms, 0.01, 600_000, w("p99 service time must be between 0.01 and 600,000 ms."));
          bad(n.p99_ms < n.service_ms, w("p99 service time can't be less than p50."));
        }
        num(n.fail_rate, 0, 1, w("failure rate must be between 0% and 100%."));
        num(n.ack_loss_rate, 0, 1, w("lost acknowledgements must be between 0% and 100%."));
        if (n.autoscale) {
          num(n.as_min, 1, 256, w("autoscale minimum must be a whole number from 1 to 256."), true);
          num(n.as_max, 1, 256, w("autoscale maximum must be a whole number from 1 to 256."), true);
          bad(n.as_max < n.as_min, w("autoscale maximum can't be less than the minimum."));
          num(n.as_target, 0.1, 1, w("autoscale target must be between 10% and 100% busy."));
          num(n.as_check_s, 0.5, 60, w("autoscale checks every 0.5 to 60 seconds."));
          num(n.as_warmup_s, 0, 300, w("new workers warm up in 0 to 300 seconds."));
        }
        break;
      case "cache":
        num(n.hit_ms, 0.01, 1_000, w("hit time must be between 0.01 and 1,000 ms."));
        bad(n.capacity !== -1 && (!Number.isInteger(n.capacity) || n.capacity < 1 || n.capacity > 1_000_000), w("capacity must be a whole number of keys from 1 to 1,000,000, or unbounded."));
        num(n.ttl_s, 0, 3_600, w("TTL must be between 0 and 3,600 seconds."));
        num(n.ttl_jitter, 0, 1, w("TTL jitter must be between 0% and 100%."));
        break;
      case "rate_limiter":
        num(n.rate_rps, 0.1, 100_000, w("rate must be between 0.1 and 100,000 a second."));
        num(n.burst, 1, 100_000, w("burst must be a whole number from 1 to 100,000."), true);
        if (n.algo !== "token_bucket") num(n.window_s, 0.1, 60, w("window must be between 0.1 and 60 seconds."));
        break;
      case "queue":
        num(n.ack_ms, 0.01, 1_000, w("time to store a message must be between 0.01 and 1,000 ms."));
        bad(n.capacity !== -1 && (!Number.isInteger(n.capacity) || n.capacity < 1 || n.capacity > 10_000_000), w("capacity must be a whole number of messages, or unbounded."));
        num(n.max_deliveries, 1, 20, w("deliveries before the dead-letter queue must be a whole number from 1 to 20."), true);
        num(n.redeliver_s, 0, 60, w("redelivery delay must be between 0 and 60 seconds."));
        break;
    }
  }

  num(d.duration_s, 1, LIMITS.duration_s, `The run must last 1 to ${LIMITS.duration_s} seconds.`, true);
  num(d.seed, 0, 2 ** 31 - 1, "The seed must be a whole number from 0 to 2,147,483,647.", true);
  if (d.traffic.length === 0) errors.push("Add at least one traffic step.");
  if (d.traffic.length > LIMITS.steps) errors.push(`Use at most ${LIMITS.steps} traffic steps.`);
  d.traffic.forEach(([t, r], i) => {
    num(t, 0, Math.max(0, d.duration_s - 0.001), `Traffic step ${i + 1} must start between 0 s and the end of the run (${d.duration_s} s).`);
    num(r, 0, LIMITS.rps, `Traffic step ${i + 1} must be between 0 and ${LIMITS.rps.toLocaleString("en")} requests a second.`);
    if (i > 0 && t <= d.traffic[i - 1]![0]) errors.push(`Traffic step ${i + 1} must start after step ${i}.`);
  });
  if (d.traffic[0] && d.traffic[0][0] !== 0) warnings.push(`No traffic arrives before ${d.traffic[0][0]} s, when the first step starts.`);
  const total = estimatedRequests(d);
  if (total > LIMITS.requests)
    errors.push(`This run would send about ${Math.round(total).toLocaleString("en")} requests. Keep it under ${LIMITS.requests.toLocaleString("en")} (lower the traffic or shorten the run) so it finishes quickly in the browser.`);
  if (needsKeys(d)) {
    num(d.keys.space, 1, 1_000_000, "The number of distinct keys must be a whole number from 1 to 1,000,000.", true);
    num(d.keys.zipf, 0, 3, "Key skew must be between 0 (uniform) and 3.");
    num(d.keys.write_ratio, 0, 1, "Writes must be between 0% and 100% of requests.");
  }
  num(d.client.timeout_ms, 0, 600_000, "The client timeout must be between 0 (wait forever) and 600,000 ms.");
  num(d.client.retries, 0, 10, "Client retries must be a whole number from 0 to 10.", true);
  if (d.client.retries > 0) num(d.client.backoff_ms, 0, 60_000, "Retry backoff must be between 0 and 60,000 ms.");
  if (d.client.retries > 0 && d.client.timeout_ms === 0) warnings.push("The client retries only failures it sees. Without a timeout it waits forever on a slow request instead of retrying it.");
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function estimatedRequests(d: Design): number {
  let total = 0;
  d.traffic.forEach(([t, r], i) => {
    const end = Math.min(d.duration_s, d.traffic[i + 1]?.[0] ?? d.duration_s);
    if (Number.isFinite(r) && end > t) total += r * (end - t);
  });
  return total * (1 + Math.max(0, d.client.retries || 0));
}

// ---------- Scenario ----------

const us = (s: number) => Math.round(s * 1_000_000);
const IGNORES =
  "This is a sandbox design. Before using it in a lesson, write what the model leaves out here: network time between nodes, real hardware limits, and anything else the lesson's claims depend on.";

/** The validated scenario the engine and the stage renderer take. Call only when validate() has no errors. */
export function toScenario(d: Design): Scenario {
  const nodes: Scenario["nodes"] = d.nodes.map((n): Scenario["nodes"][number] => {
    switch (n.kind) {
      case "lb":
        return {
          id: n.id,
          kind: "lb",
          algo: n.algo,
          health_check: us(n.health_check_s),
          ...(n.algo === "primary_replica" ? { replication_lag: Math.round(n.replication_lag_ms * 1000) } : {}),
          sync_replication: false,
          ...(n.breaker ? { breaker: { failures: n.breaker_failures, open: us(n.breaker_open_s), half_open: false } } : {}),
        };
      case "server":
        return {
          id: n.id,
          kind: "server",
          workers: n.workers,
          queue: n.queue === -1 ? "unbounded" : n.queue,
          service_ms: n.dist === "mean" ? { mean: n.service_ms } : n.dist === "fixed" ? { fixed: n.service_ms } : { p50: n.service_ms, p99: n.p99_ms },
          fail_rate: n.fail_rate,
          ack_loss_rate: n.ack_loss_rate,
          idempotent: n.idempotent,
          ...(n.autoscale ? { autoscale: { min: n.as_min, max: n.as_max, target_util: n.as_target, check: us(n.as_check_s), warmup: us(n.as_warmup_s) } } : {}),
        };
      case "cache":
        return { id: n.id, kind: "cache", hit_ms: n.hit_ms, capacity: n.capacity === -1 ? "unbounded" : n.capacity, ttl: us(n.ttl_s), ttl_jitter: n.ttl_jitter, coalesce: n.coalesce, eviction: "lru" };
      case "rate_limiter":
        return { id: n.id, kind: "rate_limiter", algo: n.algo, rate_rps: n.rate_rps, burst: n.burst, ...(n.algo !== "token_bucket" ? { window: us(n.window_s) } : {}) };
      case "queue":
        return { id: n.id, kind: "queue", ack_ms: n.ack_ms, capacity: n.capacity === -1 ? "unbounded" : n.capacity, max_deliveries: n.max_deliveries, redeliver: us(n.redeliver_s) };
    }
  });
  const keys = needsKeys(d)
    ? { space: d.keys.space, zipf: d.keys.zipf, ...(d.keys.write_ratio > 0 ? { write_ratio: d.keys.write_ratio } : {}) }
    : undefined;
  return {
    schema: 1,
    title: d.title.trim() || "Sandbox design",
    seed: d.seed,
    duration: us(d.duration_s),
    nodes,
    edges: d.edges.map(([a, b]) => [a, b] as [string, string]),
    traffic: { rps: d.traffic.map(([t, r]) => [us(t), r] as [number, number]), ...(keys ? { keys } : {}) },
    client: {
      ...(d.client.timeout_ms > 0 ? { timeout: Math.round(d.client.timeout_ms * 1000) } : {}),
      retries: d.client.retries,
      ...(d.client.retries > 0 ? { backoff: Math.round(d.client.backoff_ms * 1000) } : {}),
      jitter: d.client.retries > 0 && d.client.jitter,
    },
    events: [],
    controls: [],
    variants: [],
    ignores: IGNORES,
    narrate: [],
  };
}

// ---------- YAML ----------

/** "250ms", "20s", "2m"-style text for a whole number of microseconds. */
export function fmtDuration(u: number): string {
  if (u % 1_000_000 === 0) return `${u / 1_000_000}s`;
  if (u % 1_000 === 0) return `${u / 1_000}ms`;
  return `${u}us`;
}
const str = (s: string) => JSON.stringify(s);
const flow = (pairs: [string, string | number | boolean | undefined][]) =>
  `{ ${pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")} }`;

/** Scenario YAML a contributor can drop into content/scenarios/ and then add controls, a goal and narration to. */
export function toYaml(d: Design): string {
  const s = toScenario(d);
  const lines: string[] = [
    "# yaml-language-server: $schema=./scenario.schema.json",
    "# Made in the System Design Quest sandbox. Add predict, controls, goal and narrate before using it in a lesson.",
    "schema: 1",
    `title: ${str(s.title)}`,
    `seed: ${s.seed}`,
    `duration: ${fmtDuration(s.duration)}`,
    "",
    "nodes:",
  ];
  for (const n of s.nodes) {
    let p: [string, string | number | boolean | undefined][] = [
      ["id", n.id],
      ["kind", n.kind],
    ];
    switch (n.kind) {
      case "lb":
        p.push(["algo", n.algo], ["health_check", n.health_check === undefined ? undefined : fmtDuration(n.health_check)]);
        if (n.replication_lag !== undefined) p.push(["replication_lag", fmtDuration(n.replication_lag)]);
        if (n.breaker) p.push(["breaker", flow([["failures", n.breaker.failures], ["open", fmtDuration(n.breaker.open)]])]);
        break;
      case "server": {
        const sm = n.service_ms;
        p.push(["workers", n.workers], ["queue", n.queue], ["service_ms", "p50" in sm ? flow([["p50", sm.p50], ["p99", sm.p99]]) : "mean" in sm ? flow([["mean", sm.mean]]) : flow([["fixed", sm.fixed]])]);
        if (n.fail_rate) p.push(["fail_rate", n.fail_rate]);
        if (n.ack_loss_rate) p.push(["ack_loss_rate", n.ack_loss_rate]);
        if (n.idempotent) p.push(["idempotent", true]);
        if (n.autoscale)
          p.push([
            "autoscale",
            flow([
              ["min", n.autoscale.min],
              ["max", n.autoscale.max],
              ["target_util", n.autoscale.target_util],
              ["check", fmtDuration(n.autoscale.check)],
              ["warmup", fmtDuration(n.autoscale.warmup)],
            ]),
          ]);
        break;
      }
      case "cache":
        p.push(["hit_ms", n.hit_ms], ["capacity", n.capacity], ["ttl", fmtDuration(n.ttl)]);
        if (n.ttl_jitter) p.push(["ttl_jitter", n.ttl_jitter]);
        if (n.coalesce) p.push(["coalesce", true]);
        break;
      case "rate_limiter":
        p.push(["algo", n.algo], ["rate_rps", n.rate_rps], ["burst", n.burst]);
        if (n.window !== undefined) p.push(["window", fmtDuration(n.window)]);
        break;
      case "queue":
        p.push(["ack_ms", n.ack_ms], ["capacity", n.capacity], ["max_deliveries", n.max_deliveries]);
        if (n.redeliver !== undefined) p.push(["redeliver", fmtDuration(n.redeliver)]);
        break;
    }
    lines.push(`  - ${flow(p)}`);
    p = [];
  }
  lines.push("", s.edges.length ? "edges:" : "edges: []");
  for (const [a, b] of s.edges) lines.push(`  - [${a}, ${b}]`);
  lines.push("", "traffic:", "  rps:");
  for (const [t, r] of s.traffic.rps) lines.push(`    - [${fmtDuration(t)}, ${r}]`);
  const k = s.traffic.keys;
  if (k) lines.push(`  keys: ${flow([["space", k.space], ["zipf", k.zipf], ["write_ratio", k.write_ratio]])}`);
  const c = s.client;
  if (c.timeout !== undefined || c.retries > 0)
    lines.push(
      "",
      `client: ${flow([
        ["timeout", c.timeout === undefined ? undefined : fmtDuration(c.timeout)],
        ["retries", c.retries],
        ["backoff", c.backoff === undefined ? undefined : fmtDuration(c.backoff)],
        ["jitter", c.jitter || undefined],
      ])}`,
    );
  lines.push("", `ignores: ${str(s.ignores)}`, "");
  return lines.join("\n");
}

// ---------- URL hash ----------

export function encodeDesign(d: Design): string {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read a design from a hash value. Untrusted input: anything unexpected falls back to defaults or null. */
export function decodeDesign(text: string): Design | null {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    return normalise(raw);
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Copy fields of `raw` onto `def` where the type matches the default's. Strings are capped. */
function overlay<T extends object>(def: T, raw: unknown): T {
  if (!isObj(raw)) return def;
  const out: Record<string, unknown> = { ...(def as Record<string, unknown>) };
  for (const [k, v] of Object.entries(def)) {
    const r = raw[k];
    if (typeof r === typeof v && typeof r !== "object") out[k] = typeof r === "string" ? r.slice(0, 80) : typeof r === "number" && !Number.isFinite(r) ? v : r;
  }
  return out as T;
}

const ENUMS: Record<string, readonly string[]> = {
  "lb.algo": ["round_robin", "least_connections", "random", "key_hash", "consistent_hash", "primary_replica"],
  "rate_limiter.algo": ["token_bucket", "fixed_window", "sliding_window"],
  "server.dist": ["mean", "p50p99", "fixed"],
};

export function normalise(raw: unknown): Design | null {
  if (!isObj(raw) || !Array.isArray(raw.nodes)) return null;
  const base = overlay(emptyDesign(), raw);
  const nodes: SbNode[] = [];
  for (const rn of raw.nodes.slice(0, LIMITS.nodes * 2)) {
    if (!isObj(rn) || typeof rn.kind !== "string" || !(rn.kind in KIND_NAME) || typeof rn.id !== "string") continue;
    const n = overlay(defaultNode(rn.kind as Kind, rn.id.slice(0, 24)), rn) as SbNode;
    n.id = rn.id.slice(0, 24);
    for (const [key, allowed] of Object.entries(ENUMS)) {
      const [kind, field] = key.split(".") as [string, string];
      const rec = n as unknown as Record<string, unknown>;
      if (n.kind === kind && !allowed.includes(String(rec[field]))) rec[field] = (defaultNode(n.kind, n.id) as unknown as Record<string, unknown>)[field];
    }
    nodes.push(n);
  }
  const pairs = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2).slice(0, max) : [];
  const edges = pairs(raw.edges, 64)
    .filter((p): p is [string, string] => typeof p[0] === "string" && typeof p[1] === "string")
    .map(([a, b]) => [a.slice(0, 24), b.slice(0, 24)] as [string, string]);
  const traffic = pairs(raw.traffic, LIMITS.steps * 2)
    .filter((p): p is [number, number] => typeof p[0] === "number" && typeof p[1] === "number")
    .map(([t, r]) => [t, r] as [number, number]);
  return {
    ...base,
    v: 1,
    nodes,
    edges,
    traffic: traffic.length ? traffic : [[0, 50]],
    keys: overlay(base.keys, raw.keys),
    client: overlay(base.client, raw.client),
  };
}
