import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { simulate, type SimResult } from "@sdq/sim-engine";
import { toSimConfig } from "@sdq/schema/convert";
import type { Scenario } from "@sdq/schema";
import { SimStage } from "../sim/SimStage";
import { Timeline } from "../sim/Timeline";
import { Readouts, fmtMs } from "../sim/Readouts";
import { prefersReducedMotion, usePlayback } from "../sim/usePlayback";
import {
  KIND_NAME,
  LIMITS,
  PRESETS,
  clone,
  connectTargets,
  decodeDesign,
  defaultNode,
  emptyDesign,
  encodeDesign,
  entries,
  freshId,
  incoming,
  needsKeys,
  outgoing,
  toScenario,
  toYaml,
  validate,
  type Design,
  type Kind,
  type SbNode,
} from "./model";

const KINDS: Kind[] = ["lb", "server", "cache", "rate_limiter", "queue"];
const ID_RE = /^[a-z][a-z0-9_-]*$/;

// ---------- Small fields ----------

function Num({ label, value, onChange, unit, step = 1, min, hint }: { label: string; value: number; onChange: (v: number) => void; unit?: string; step?: number; min?: number; hint?: string }) {
  const id = useId();
  return (
    <div className="sb-field">
      <label htmlFor={id}>{label}</label>
      <span className="sb-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        />
        {unit && <span className="quiet">{unit}</span>}
      </span>
      {hint && <span className="sb-hint quiet">{hint}</span>}
    </div>
  );
}

const Pct = ({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) => (
  <Num label={label} value={Number.isFinite(value) ? Math.round(value * 10_000) / 100 : NaN} onChange={(v) => onChange(v / 100)} unit="%" step={0.1} min={0} hint={hint} />
);

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="sb-field sb-toggle">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
      {hint && <span className="sb-hint quiet">{hint}</span>}
    </div>
  );
}

function Pick<T extends string>({ label, value, options, onChange, hint }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="sb-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
      {hint && <span className="sb-hint quiet">{hint}</span>}
    </div>
  );
}

/** A count or "unbounded" (stored as -1). */
function Bounded({ label, value, onChange, unit }: { label: string; value: number; onChange: (v: number) => void; unit: string }) {
  return (
    <div className="sb-pair">
      <Toggle label={`${label}: unbounded`} checked={value === -1} onChange={(on) => onChange(on ? -1 : 100)} />
      {value !== -1 && <Num label={label} value={value} onChange={onChange} unit={unit} min={0} />}
    </div>
  );
}

const Fields = ({ children }: { children: ReactNode }) => <div className="sb-fields">{children}</div>;

const LB_ALGOS: [string, string][] = [
  ["round_robin", "Round robin"],
  ["least_connections", "Least connections"],
  ["random", "Random"],
  ["key_hash", "Hash mod N (shards)"],
  ["consistent_hash", "Consistent hashing (shards)"],
  ["primary_replica", "Primary and replicas"],
];

// ---------- Node properties ----------

function NodeProps({ n, set }: { n: SbNode; set: (patch: Partial<SbNode>) => void }) {
  switch (n.kind) {
    case "lb":
      return (
        <Fields>
          <Pick
            label="How it picks a server"
            value={n.algo}
            options={LB_ALGOS as [typeof n.algo, string][]}
            onChange={(algo) => set({ algo })}
            hint={
              n.algo === "primary_replica"
                ? "Writes go to the first server connected; reads go to the others."
                : n.algo === "key_hash" || n.algo === "consistent_hash"
                  ? "Each key always goes to the same server, even when it's down."
                  : undefined
            }
          />
          <Num label="Notices a dead server after" value={n.health_check_s} onChange={(v) => set({ health_check_s: v })} unit="s" step={0.5} min={0} />
          {n.algo === "primary_replica" && <Num label="Replication lag" value={n.replication_lag_ms} onChange={(v) => set({ replication_lag_ms: v })} unit="ms" step={10} min={0} />}
          <Toggle label="Circuit breaker per server" checked={n.breaker} onChange={(breaker) => set({ breaker })} />
          {n.breaker && (
            <>
              <Num label="Opens after failures in a row" value={n.breaker_failures} onChange={(v) => set({ breaker_failures: v })} min={1} />
              <Num label="Stays open for" value={n.breaker_open_s} onChange={(v) => set({ breaker_open_s: v })} unit="s" step={0.5} min={0} />
            </>
          )}
        </Fields>
      );
    case "server":
      return (
        <Fields>
          <Num label="Workers" value={n.workers} onChange={(v) => set({ workers: v })} min={1} hint="Requests it can work on at once." />
          <Bounded label="Waiting room" value={n.queue} onChange={(v) => set({ queue: v })} unit="requests" />
          <Pick
            label="Service time"
            value={n.dist}
            options={[
              ["mean", "Varies around a mean"],
              ["p50p99", "Long tail (p50 and p99)"],
              ["fixed", "Always the same"],
            ]}
            onChange={(dist) => set({ dist })}
          />
          <Num label={n.dist === "p50p99" ? "p50 service time" : n.dist === "fixed" ? "Service time" : "Mean service time"} value={n.service_ms} onChange={(v) => set({ service_ms: v })} unit="ms" step={1} min={0} />
          {n.dist === "p50p99" && <Num label="p99 service time" value={n.p99_ms} onChange={(v) => set({ p99_ms: v })} unit="ms" step={1} min={0} />}
          <Pct label="Requests that fail" value={n.fail_rate} onChange={(v) => set({ fail_rate: v })} />
          <Pct label="Lost acknowledgements" value={n.ack_loss_rate} onChange={(v) => set({ ack_loss_rate: v })} hint="Queue workers only: done, but the queue never hears, so it delivers again." />
          <Toggle label="Idempotent: skips messages it has already processed" checked={n.idempotent} onChange={(idempotent) => set({ idempotent })} />
          <Toggle label="Autoscale workers" checked={n.autoscale} onChange={(autoscale) => set({ autoscale })} />
          {n.autoscale && (
            <>
              <Num label="At least" value={n.as_min} onChange={(v) => set({ as_min: v })} unit="workers" min={1} />
              <Num label="At most" value={n.as_max} onChange={(v) => set({ as_max: v })} unit="workers" min={1} />
              <Pct label="Target busy" value={n.as_target} onChange={(v) => set({ as_target: v })} />
              <Num label="Checks every" value={n.as_check_s} onChange={(v) => set({ as_check_s: v })} unit="s" step={0.5} min={0} />
              <Num label="New workers warm up for" value={n.as_warmup_s} onChange={(v) => set({ as_warmup_s: v })} unit="s" min={0} />
            </>
          )}
        </Fields>
      );
    case "cache":
      return (
        <Fields>
          <Num label="Time to answer a hit" value={n.hit_ms} onChange={(v) => set({ hit_ms: v })} unit="ms" step={0.5} min={0} />
          <Bounded label="Keys it holds" value={n.capacity} onChange={(v) => set({ capacity: v })} unit="keys" />
          <Num label="TTL" value={n.ttl_s} onChange={(v) => set({ ttl_s: v })} unit="s" min={0} hint="How long a key stays before it expires." />
          <Pct label="TTL jitter" value={n.ttl_jitter} onChange={(v) => set({ ttl_jitter: v })} hint="Spreads expiry times so keys don't all expire together." />
          <Toggle label="Coalesce misses: one fetch per key at a time" checked={n.coalesce} onChange={(coalesce) => set({ coalesce })} />
        </Fields>
      );
    case "rate_limiter":
      return (
        <Fields>
          <Pick
            label="Algorithm"
            value={n.algo}
            options={[
              ["token_bucket", "Token bucket"],
              ["fixed_window", "Fixed window"],
              ["sliding_window", "Sliding window"],
            ]}
            onChange={(algo) => set({ algo })}
          />
          <Num label="Rate" value={n.rate_rps} onChange={(v) => set({ rate_rps: v })} unit="a second" min={0} />
          <Num label="Burst" value={n.burst} onChange={(v) => set({ burst: v })} unit="requests" min={1} />
          {n.algo !== "token_bucket" && <Num label="Window" value={n.window_s} onChange={(v) => set({ window_s: v })} unit="s" step={0.1} min={0} />}
        </Fields>
      );
    case "queue":
      return (
        <Fields>
          <Num label="Time to store a message" value={n.ack_ms} onChange={(v) => set({ ack_ms: v })} unit="ms" step={0.5} min={0} />
          <Bounded label="Messages it holds" value={n.capacity} onChange={(v) => set({ capacity: v })} unit="messages" />
          <Num label="Deliveries before the dead-letter queue" value={n.max_deliveries} onChange={(v) => set({ max_deliveries: v })} min={1} />
          <Num label="Redeliver a failed message after" value={n.redeliver_s} onChange={(v) => set({ redeliver_s: v })} unit="s" step={0.5} min={0} />
        </Fields>
      );
  }
}

// ---------- Run summary ----------

function summarise(s: Scenario, r: SimResult): string {
  const m = r.summary;
  const queued = s.nodes.some((n) => n.kind === "queue");
  const lat = queued ? "producers acknowledged in p99" : "p99";
  const parts = [`${m.requests.toLocaleString("en")} requests`, `${lat} ${fmtMs(m.p99_us)}`, `worst second ${fmtMs(m.worst_p99_us)}`, `${(m.error_rate * 100).toFixed(1)}% failed`];
  if (m.cache_hit_rate !== null) parts.push(`${Math.round(m.cache_hit_rate * 100)}% cache hits`);
  if (m.limited) parts.push(`${m.limited.toLocaleString("en")} turned away by the limiter`);
  if (queued)
    parts.push(`p99 time to process ${fmtMs(m.processing_p99_us)}`, `up to ${m.max_backlog.toLocaleString("en")} messages waiting`, `${m.dead_lettered} dead-lettered`);
  if (m.duplicates) parts.push(`${m.duplicates} processed twice`);
  if (m.reads && m.stale_reads) parts.push(`${((m.stale_reads / m.reads) * 100).toFixed(1)}% of reads stale`);
  if (m.breaker_rejected) parts.push(`${m.breaker_rejected.toLocaleString("en")} failed fast by a breaker`);
  return `Run finished: ${parts.join(", ")}.`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- The island ----------

interface Run {
  scenario: Scenario;
  result: SimResult;
  /** The design JSON the run was made from, to tell when it's out of date. */
  json: string;
}

/** Free graph builder: any topology of the engine's node kinds, run in the browser, shareable by link and as scenario YAML. */
export default function Sandbox() {
  const [design, setDesign] = useState<Design>(() => clone(PRESETS[0]!.design));
  const [selected, setSelected] = useState<string | null>("lb");
  const [addKind, setAddKind] = useState<Kind>("server");
  const [connectTo, setConnectTo] = useState("");
  const [rename, setRename] = useState<{ for: string; text: string } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [runError, setRunError] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [showYaml, setShowYaml] = useState(false);
  const [linkNotice, setLinkNotice] = useState("");
  const [shareMsg, setShareMsg] = useState("");
  const [reduced, setReduced] = useState(false);
  const loaded = useRef(false);
  const errorsRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Load a shared design from the hash, then keep the hash in step with every change.
  useEffect(() => {
    setReduced(prefersReducedMotion());
    const m = /^#d=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (m) {
      const d = decodeDesign(m[1]!);
      if (d) {
        setDesign(d);
        setSelected(d.nodes[0]?.id ?? null);
        setLinkNotice("Loaded the design from this link.");
      } else setLinkNotice("The design in this link couldn't be read, so the sandbox started from a preset.");
    }
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      history.replaceState(null, "", `${location.pathname}${location.search}#d=${encodeDesign(design)}`);
    } catch {
      /* some embedded browsers refuse */
    }
  }, [design]);

  const problems = useMemo(() => validate(design), [design]);
  const json = useMemo(() => JSON.stringify(design), [design]);
  const yaml = useMemo(() => (problems.errors.length ? "" : toYaml(design)), [design, problems]);
  const node = design.nodes.find((n) => n.id === selected) ?? null;
  const conn = node ? connectTargets(design, node.id) : { targets: [] as string[] };
  const entry = entries(design);

  const pb = usePlayback(run?.scenario.duration ?? 1_000_000, { speed: 2 });
  useEffect(() => {
    if (!run) return;
    pb.seek(0);
    if (reduced) pb.seek(run.scenario.duration);
    else pb.play();
  }, [run]);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    resultRef.current = el;
    pb.observe(el);
  }, []);
  const finished = run !== null && pb.t >= run.scenario.duration;

  const update = (fn: (d: Design) => void) =>
    setDesign((d) => {
      const next = clone(d);
      fn(next);
      return next;
    });
  const setNode = (patch: Partial<SbNode>) => update((d) => (d.nodes = d.nodes.map((n) => (n.id === selected ? ({ ...n, ...patch } as SbNode) : n))));

  const loadPreset = (d: Design, label: string) => {
    setDesign(clone(d));
    setSelected(d.nodes[0]?.id ?? null);
    setRun(null);
    setRunError("");
    setLinkNotice("");
    setNotice(`Started from: ${label}.`);
  };

  const addNode = () => {
    if (design.nodes.length >= LIMITS.nodes) return setNotice(`The sandbox holds up to ${LIMITS.nodes} nodes.`);
    const id = freshId(addKind, design.nodes);
    update((d) => d.nodes.push(defaultNode(addKind, id)));
    setSelected(id);
    setNotice(`Added ${KIND_NAME[addKind].toLowerCase()} ${id}. Its settings are open below the list.`);
  };

  const removeNode = (id: string) => {
    update((d) => {
      d.nodes = d.nodes.filter((n) => n.id !== id);
      d.edges = d.edges.filter(([a, b]) => a !== id && b !== id);
    });
    setSelected(design.nodes.find((n) => n.id !== id)?.id ?? null);
    setNotice(`Removed ${id} and its connections.`);
  };

  const connect = () => {
    if (!node) return;
    const target = conn.targets.includes(connectTo) ? connectTo : conn.targets[0];
    if (!target) return;
    update((d) => d.edges.push([node.id, target]));
    setConnectTo("");
    setNotice(`${node.id} now sends to ${target}.`);
  };

  const disconnect = (a: string, b: string) => {
    update((d) => (d.edges = d.edges.filter(([x, y]) => !(x === a && y === b))));
    setNotice(`${a} no longer sends to ${b}.`);
  };

  const renameError = (text: string, old: string) =>
    !ID_RE.test(text)
      ? "Start with a lowercase letter; use lowercase letters, digits, - and _."
      : text !== old && design.nodes.some((n) => n.id === text)
        ? `Another node is already called ${text}.`
        : text.length > 24
          ? "Keep names to 24 characters."
          : "";
  const commitRename = () => {
    if (!rename || !node || rename.for !== node.id) return;
    const text = rename.text.trim();
    if (text === node.id || renameError(text, node.id)) return;
    const old = node.id;
    update((d) => {
      d.nodes = d.nodes.map((n) => (n.id === old ? { ...n, id: text } : n));
      d.edges = d.edges.map(([a, b]) => [a === old ? text : a, b === old ? text : b] as [string, string]);
    });
    setSelected(text);
    setRename(null);
    setNotice(`Renamed ${old} to ${text}.`);
  };

  const doRun = () => {
    if (problems.errors.length) {
      setNotice(`Fix ${problems.errors.length === 1 ? "the problem" : `the ${problems.errors.length} problems`} listed before running.`);
      errorsRef.current?.focus();
      return;
    }
    setRunning(true);
    setRunError("");
    // Let the "Running" state paint before the engine takes the main thread.
    setTimeout(() => {
      try {
        const scenario = toScenario(design);
        const result = simulate(toSimConfig(scenario));
        setRun({ scenario, result, json });
        setTimeout(() => resultRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }), 30);
      } catch (e) {
        setRun(null);
        setRunError(`The simulator couldn't run this design: ${(e as Error).message}`);
      }
      setRunning(false);
    }, 30);
  };

  const traffic = (fn: (t: [number, number][]) => [number, number][]) => update((d) => (d.traffic = fn(d.traffic)));

  return (
    <div className="sandbox">
      <p className="sr-only" aria-live="polite">
        {notice}
      </p>

      <section className="sb-panel" aria-labelledby="sb-start">
        <h2 id="sb-start">Start from</h2>
        <ul className="sb-presets">
          {PRESETS.map((p) => (
            <li key={p.id}>
              <button type="button" className="btn small ghost" onClick={() => loadPreset(p.design, p.name)}>
                {p.name}
              </button>
              <span className="quiet">{p.blurb}</span>
            </li>
          ))}
          <li>
            <button type="button" className="btn small ghost" onClick={() => loadPreset(emptyDesign(), "one server")}>
              One server
            </button>
            <span className="quiet">A blank start: a single server to build out from.</span>
          </li>
        </ul>
        {linkNotice && <p className="sb-notice">{linkNotice}</p>}
      </section>

      <section className="sb-panel" aria-labelledby="sb-design">
        <h2 id="sb-design">Your design</h2>
        <div className="sb-field sb-title">
          <label htmlFor="sb-title-input">Name</label>
          <input id="sb-title-input" type="text" maxLength={80} value={design.title} onChange={(e) => update((d) => (d.title = e.target.value))} />
        </div>
        <p className="quiet sb-small">
          Traffic enters at the one node nothing points at{entry.length === 1 ? `: here, ${entry[0]}` : ""}. Pick a node to change its settings and connections.
        </p>
        <ul className="sb-nodes">
          {design.nodes.map((n) => {
            const outs = outgoing(design, n.id);
            return (
              <li key={n.id}>
                <button type="button" className={`sb-node ${n.id === selected ? "on" : ""}`} aria-pressed={n.id === selected} onClick={() => setSelected(n.id)}>
                  <strong>{n.id}</strong>
                  <span className="quiet">
                    {KIND_NAME[n.kind]}
                    {outs.length ? `, sends to ${outs.join(", ")}` : n.kind === "server" ? "" : ", not connected yet"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="sb-add">
          <div className="sb-field">
            <label htmlFor="sb-add-kind">New node</label>
            <select id="sb-add-kind" value={addKind} onChange={(e) => setAddKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_NAME[k]}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn small" onClick={addNode} disabled={design.nodes.length >= LIMITS.nodes}>
            Add node
          </button>
        </div>

        {node && (
          <div className="sb-editor" role="group" aria-labelledby="sb-editing">
            <h3 id="sb-editing">
              Editing {node.id} <span className="quiet">({KIND_NAME[node.kind].toLowerCase()})</span>
            </h3>
            <div className="sb-rename">
              <div className="sb-field">
                <label htmlFor="sb-rename-input">Name</label>
                <input
                  id="sb-rename-input"
                  type="text"
                  maxLength={24}
                  autoCapitalize="none"
                  spellCheck={false}
                  value={rename?.for === node.id ? rename.text : node.id}
                  aria-describedby="sb-rename-error"
                  onChange={(e) => setRename({ for: node.id, text: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && commitRename()}
                  onBlur={commitRename}
                />
              </div>
              <span id="sb-rename-error" className="sb-hint" style={{ color: "var(--red)" }}>
                {rename?.for === node.id ? renameError(rename.text.trim(), node.id) : ""}
              </span>
            </div>

            <NodeProps n={node} set={setNode} />

            <h4>Connections</h4>
            {incoming(design, node.id).length > 0 && <p className="sb-small quiet">Receives from {incoming(design, node.id).join(", ")}.</p>}
            {outgoing(design, node.id).length > 0 ? (
              <ul className="sb-edges">
                {outgoing(design, node.id).map((b, i) => (
                  <li key={b}>
                    <span>
                      Sends to <strong>{b}</strong>
                      {node.kind === "lb" && node.algo === "primary_replica" ? (i === 0 ? " (primary)" : " (replica)") : ""}
                    </span>
                    <button type="button" className="btn small ghost" onClick={() => disconnect(node.id, b)} aria-label={`Disconnect ${node.id} from ${b}`}>
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              node.kind !== "server" && <p className="sb-small quiet">Doesn't send anywhere yet.</p>
            )}
            {conn.targets.length > 0 ? (
              <div className="sb-add">
                <div className="sb-field">
                  <label htmlFor="sb-connect">Send to</label>
                  <select id="sb-connect" value={conn.targets.includes(connectTo) ? connectTo : conn.targets[0]} onChange={(e) => setConnectTo(e.target.value)}>
                    {conn.targets.map((t) => (
                      <option key={t} value={t}>
                        {t} ({KIND_NAME[design.nodes.find((n) => n.id === t)!.kind].toLowerCase()})
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className="btn small" onClick={connect}>
                  Connect
                </button>
              </div>
            ) : (
              conn.reason && <p className="sb-small quiet">{conn.reason}</p>
            )}
            <button type="button" className="btn small danger sb-remove" onClick={() => removeNode(node.id)}>
              Remove {node.id}
            </button>
          </div>
        )}
      </section>

      <section className="sb-panel" aria-labelledby="sb-traffic">
        <h2 id="sb-traffic">Traffic and run settings</h2>
        <ol className="sb-steps">
          {design.traffic.map(([t, r], i) => (
            <li key={i}>
              <Num label={`Step ${i + 1} starts at`} value={t} onChange={(v) => traffic((all) => all.map((s, j) => (j === i ? [v, s[1]] : s)))} unit="s" min={0} />
              <Num label="Requests a second" value={r} onChange={(v) => traffic((all) => all.map((s, j) => (j === i ? [s[0], v] : s)))} min={0} step={10} />
              <button
                type="button"
                className="btn small ghost"
                disabled={design.traffic.length <= 1}
                aria-label={`Remove traffic step ${i + 1}`}
                onClick={() => traffic((all) => all.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn small ghost"
          disabled={design.traffic.length >= LIMITS.steps}
          onClick={() =>
            traffic((all) => {
              const last = all[all.length - 1] ?? [0, 50];
              const at = Math.min(Math.max(0, design.duration_s - 1), (Number.isFinite(last[0]) ? last[0] : 0) + 10);
              return [...all, [at, Number.isFinite(last[1]) ? last[1] : 50]];
            })
          }
        >
          Add a traffic step
        </button>
        <Fields>
          <Num label="Run for" value={design.duration_s} onChange={(v) => update((d) => (d.duration_s = v))} unit="s" min={1} />
          <div className="sb-pair">
            <Num label="Seed" value={design.seed} onChange={(v) => update((d) => (d.seed = v))} min={0} hint="Same seed, same run, every time." />
            <button type="button" className="btn small ghost" onClick={() => update((d) => (d.seed = Math.floor(Math.random() * 100_000)))}>
              New seed
            </button>
          </div>
        </Fields>
        {needsKeys(design) ? (
          <>
            <h3>Keys</h3>
            <p className="sb-small quiet">Which keys requests ask for. Caches and key-routing load balancers use these.</p>
            <Fields>
              <Num label="Distinct keys" value={design.keys.space} onChange={(v) => update((d) => (d.keys.space = v))} min={1} />
              <Num label="Skew (zipf)" value={design.keys.zipf} onChange={(v) => update((d) => (d.keys.zipf = v))} step={0.1} min={0} hint="0 is even; about 1 means a few keys are very hot." />
              <Pct label="Writes" value={design.keys.write_ratio} onChange={(v) => update((d) => (d.keys.write_ratio = v))} hint="Used by primary and replicas." />
            </Fields>
          </>
        ) : (
          <p className="sb-small quiet">Key settings appear when the design has a cache or a load balancer that routes by key.</p>
        )}
        <details className="sb-client">
          <summary>Client timeouts and retries</summary>
          <Fields>
            <Num label="Timeout" value={design.client.timeout_ms} onChange={(v) => update((d) => (d.client.timeout_ms = v))} unit="ms" step={50} min={0} hint="0 waits forever." />
            <Num label="Retries" value={design.client.retries} onChange={(v) => update((d) => (d.client.retries = v))} min={0} />
            {design.client.retries > 0 && (
              <>
                <Num label="First backoff" value={design.client.backoff_ms} onChange={(v) => update((d) => (d.client.backoff_ms = v))} unit="ms" step={10} min={0} hint="Doubles on each retry." />
                <Toggle label="Jitter: randomise the backoff" checked={design.client.jitter} onChange={(v) => update((d) => (d.client.jitter = v))} />
              </>
            )}
          </Fields>
        </details>
      </section>

      <section className="sb-panel" aria-labelledby="sb-run">
        <h2 id="sb-run">Check and run</h2>
        <div ref={errorsRef} tabIndex={-1} className="sb-problems">
          {problems.errors.length > 0 ? (
            <>
              <p>
                <strong style={{ color: "var(--red)" }}>
                  {problems.errors.length === 1 ? "One thing to fix" : `${problems.errors.length} things to fix`} before it can run:
                </strong>
              </p>
              <ul className="sb-errors">
                {problems.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              <strong style={{ color: "var(--mint)" }}>Ready to run.</strong> <span className="quiet">The wiring checks out.</span>
            </p>
          )}
          {problems.warnings.length > 0 && (
            <ul className="sb-warnings">
              {problems.warnings.map((w) => (
                <li key={w}>
                  <strong>Worth knowing:</strong> {w}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="btn" onClick={doRun} disabled={running} aria-describedby="sb-run-status">
          {running ? "Running" : run ? "Run it again" : "Run the simulation"}
        </button>
        <p id="sb-run-status" className="sb-small" aria-live="polite">
          {running ? "Running the simulation." : runError}
          {!running && run && run.json !== json && !runError ? "You've changed the design since this run. Run it again to see the effect." : ""}
        </p>
      </section>

      {run && (
        <div className="instrument" ref={stageRef}>
          <SimStage scenario={run.scenario} result={run.result} t={pb.t} reducedMotion={reduced} />
          <Readouts scenario={run.scenario} result={run.result} t={pb.t} />
          <div style={{ borderTop: "1px solid var(--rule)", padding: "6px 8px 2px" }}>
            <Timeline result={run.result} t={pb.t} metric={run.scenario.nodes.some((n) => n.kind === "queue") ? "processing" : "latency"} onSeek={pb.seek} />
          </div>
          <div className="narration" aria-live="polite">
            {finished ? summarise(run.scenario, run.result) : "Playing your run. Use the controls below to pause or step through it."}
          </div>
          <div className="instrument-bar">
            <button type="button" className="btn small ghost" onClick={() => (pb.playing ? pb.pause() : pb.play())}>
              {pb.playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="btn small ghost" onClick={() => pb.seek(pb.t - 1_000_000)}>
              Back 1s
            </button>
            <button type="button" className="btn small ghost" onClick={() => pb.seek(pb.t + 1_000_000)}>
              Forward 1s
            </button>
            <label className="quiet" style={{ fontSize: "0.85rem", display: "flex", gap: 6, alignItems: "center" }}>
              Speed
              <select value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
              </select>
            </label>
            <span className="quiet num" style={{ marginLeft: "auto", fontSize: "0.85rem" }}>
              {(pb.t / 1e6).toFixed(0)}s of {(run.scenario.duration / 1e6).toFixed(0)}s
            </span>
          </div>
        </div>
      )}
      {run && (
        <aside className="callout" aria-label="What this model ignores">
          <strong>What this model ignores.</strong> Network time between nodes, real hardware, and everything the engine doesn't model: servers fail
          instantly rather than degrading, caches never saturate, and traffic is random arrivals at the rates you set. Treat the numbers as a model of
          your design, not a forecast.
        </aside>
      )}

      <section className="sb-panel" aria-labelledby="sb-share">
        <h2 id="sb-share">Share it</h2>
        <p className="sb-small quiet">The page address always holds your current design, so the link opens exactly this sandbox.</p>
        <div className="sb-share">
          <button type="button" className="btn small ghost" onClick={() => void copy(location.href).then((ok) => setShareMsg(ok ? "Link copied." : "Couldn't copy. Copy the address from your browser's address bar instead."))}>
            Copy share link
          </button>
          <button
            type="button"
            className="btn small ghost"
            disabled={!yaml}
            onClick={() =>
              void copy(yaml).then((ok) => {
                setShareMsg(ok ? "Scenario YAML copied. Paste it into a new file in content/scenarios/." : "Couldn't copy, so the YAML is shown below to copy by hand.");
                if (!ok) setShowYaml(true);
              })
            }
          >
            Copy as scenario YAML
          </button>
          <button type="button" className="btn small ghost" disabled={!yaml} aria-expanded={showYaml} aria-controls="sb-yaml" onClick={() => setShowYaml((v) => !v)}>
            {showYaml ? "Hide the YAML" : "Show the YAML"}
          </button>
        </div>
        <p className="sb-small" aria-live="polite">
          {shareMsg}
        </p>
        {!yaml && <p className="sb-small quiet">Fix the problems above to get scenario YAML.</p>}
        {showYaml && yaml && (
          <textarea id="sb-yaml" className="sb-yaml" readOnly rows={Math.min(30, yaml.split("\n").length + 1)} value={yaml} aria-label="Scenario YAML" onFocus={(e) => e.currentTarget.select()} />
        )}
        <p className="sb-small quiet">
          Turning it into a lesson? The YAML is a starting point: add <code>predict</code>, <code>controls</code>, a <code>goal</code> and an honest{" "}
          <code>ignores</code> note, as <code>docs/AUTHORING.md</code> describes.
        </p>
      </section>
    </div>
  );
}
