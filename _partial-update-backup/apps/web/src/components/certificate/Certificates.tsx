import { useEffect, useMemo, useState } from "react";
import { listEvents, onProgressChange } from "@sdq/game";
import { downloadSvgAsPng } from "../../lib/resultCard";
import {
  CERT_EVENTS,
  CERT_H,
  CERT_W,
  actDone,
  actItems,
  certificateSvg,
  cleanName,
  isMet,
  metSet,
  type ActReqs,
  type ModuleReqs,
  type ProgressEvent,
  type Req,
} from "../../lib/certificate";

const NAME_KEY = "sdq-certificate-name";
const base = import.meta.env.BASE_URL;
const link = (p: string) => `${base.replace(/\/$/, "")}${p}`;

const KIND: Record<Req["kind"], string> = { check: "Lesson check", problem: "Classic problem", boss: "Boss fight" };

function Meter({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="cert-meter">
      <div className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${done} of ${total}`}>
        <span style={{ width: `${pct}%`, background: done === total ? "var(--mint)" : "var(--cobalt)" }} />
      </div>
      <span className="num quiet">
        {done} of {total}
      </span>
    </div>
  );
}

function ModuleList({ m, met }: { m: ModuleReqs; met: Set<string> }) {
  const done = m.items.filter((r) => isMet(met, r)).length;
  return (
    <details className="cert-module">
      <summary>
        <span>
          Module {m.n}: {m.title}
        </span>{" "}
        <span className={`num cert-count ${done === m.items.length ? "ok" : ""}`}>
          {done === m.items.length ? "Done" : `${done} of ${m.items.length}`}
        </span>
      </summary>
      <ul className="cert-items">
        {m.items.map((r) => {
          const ok = isMet(met, r);
          return (
            <li key={`${r.kind}:${r.ref}`} className={ok ? "ok" : ""}>
              <span className="cert-mark" aria-hidden="true">
                {ok ? "✓" : "○"}
              </span>
              <a href={link(r.path)}>{r.title}</a> <span className="quiet">{KIND[r.kind]}, {ok ? "done" : "not yet"}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Progress per act and for the whole course, read from this device, with a certificate for each finished one. */
export default function Certificates({ acts }: { acts: ActReqs[] }) {
  const [events, setEvents] = useState<ProgressEvent[] | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const load = () => void listEvents(CERT_EVENTS).then((e) => setEvents(e));
    load();
    try {
      setName(localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      /* storage blocked */
    }
    const off = onProgressChange(load);
    return () => void off();
  }, []);

  const met = useMemo(() => metSet(events ?? []), [events]);
  const all = acts.flatMap(actItems);
  const allDone = all.filter((r) => isMet(met, r)).length;
  const courseDone = acts.every((a) => actDone(a, met));
  const anyDone = courseDone || acts.some((a) => actDone(a, met));

  const updateName = (v: string) => {
    setName(v);
    try {
      localStorage.setItem(NAME_KEY, v);
    } catch {
      /* storage blocked */
    }
  };

  const download = async (scope: ActReqs | "course") => {
    const clean = cleanName(name);
    if (!clean) {
      setStatus("Type the name you want on the certificate first.");
      document.getElementById("cert-name")?.focus();
      return;
    }
    const whole = scope === "course";
    const modules = (whole ? acts.flatMap((a) => a.modules) : scope.modules).map((m) => ({ n: m.n, title: m.title }));
    const items = whole ? all : actItems(scope);
    const svg = certificateSvg({
      name: clean,
      scope: whole ? "the whole course" : `Act ${scope.n}: ${scope.title}`,
      whole,
      modules,
      counts: {
        checks: items.filter((r) => r.kind === "check").length,
        problems: items.filter((r) => r.kind === "problem").length,
        bosses: items.filter((r) => r.kind === "boss").map((r) => r.title),
      },
      date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
      url: `${location.host}${base}`,
    });
    setStatus("Drawing your certificate.");
    const ok = await downloadSvgAsPng(svg, CERT_W, CERT_H, whole ? "system-design-quest-certificate-course.png" : `system-design-quest-certificate-act-${scope.n}.png`);
    setStatus(ok ? "Certificate downloaded. Check your downloads folder." : "This browser couldn't draw the image. Try another browser.");
  };

  const remaining = (n: number) => `${n} more to go before this certificate unlocks.`;

  return (
    <div className="certs">
      <p className="quiet" aria-live="polite">
        {events === null
          ? "Reading your progress from this browser."
          : `You've finished ${allDone} of ${all.length} requirements in this browser.${allDone === 0 ? " Pass a lesson check and it shows up here." : ""}`}
      </p>

      {anyDone && (
        <div className="callout cert-name">
          <label htmlFor="cert-name">
            <strong>Name on your certificates</strong>
          </label>
          <input id="cert-name" type="text" maxLength={60} autoComplete="name" value={name} onChange={(e) => updateName(e.target.value)} placeholder="Your name" />
          <p className="quiet" style={{ margin: 0, fontSize: "0.9rem" }}>
            It's only drawn into the image. Nothing is sent anywhere.
          </p>
        </div>
      )}
      <p className="cert-status" aria-live="polite">
        {status}
      </p>

      <section className="cert-card" aria-labelledby="cert-course">
        <div className="cert-head">
          <h2 id="cert-course">The whole course</h2>
          {courseDone ? <span className="cert-badge">Unlocked</span> : null}
        </div>
        <p className="quiet">Every act below.</p>
        <Meter done={allDone} total={all.length} label="Whole course progress" />
        {courseDone ? (
          <button type="button" className="btn" onClick={() => void download("course")}>
            Download the course certificate
          </button>
        ) : (
          <p className="quiet">{remaining(all.length - allDone)}</p>
        )}
      </section>

      {acts.map((a) => {
        const items = actItems(a);
        const done = items.filter((r) => isMet(met, r)).length;
        const ok = done === items.length;
        const boss = a.modules.flatMap((m) => m.items).filter((r) => r.kind === "boss");
        return (
          <section key={a.n} className="cert-card" aria-labelledby={`cert-act-${a.n}`}>
            <div className="cert-head">
              <h2 id={`cert-act-${a.n}`}>
                Act {a.n}: {a.title}
              </h2>
              {ok ? <span className="cert-badge">Unlocked</span> : null}
            </div>
            <p className="quiet">
              Pass every lesson check{items.some((r) => r.kind === "problem") ? ", solve every classic problem" : ""}
              {boss.length ? `, and win ${boss.length === 1 ? "the boss fight" : `all ${boss.length} boss fights`} with at least one star` : ""}.
            </p>
            <Meter done={done} total={items.length} label={`Act ${a.n} progress`} />
            {a.modules.map((m) => (
              <ModuleList key={m.n} m={m} met={met} />
            ))}
            {ok ? (
              <button type="button" className="btn" onClick={() => void download(a)}>
                Download the Act {a.n} certificate
              </button>
            ) : (
              <p className="quiet">{remaining(items.length - done)}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
