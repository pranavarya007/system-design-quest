/**
 * Certificates: which act requirements a learner has met on this device, and the certificate image.
 * Browser-safe: no file system, no Zod. Requirements are computed at build time in certificateReqs.ts.
 */
import { esc } from "./resultCard";

export interface Req {
  /** check: a lesson check passed. problem: a classic problem marked done. boss: at least one star. */
  kind: "check" | "problem" | "boss";
  /** The event ref: quiz lesson slug, practice id or challenge id. */
  ref: string;
  title: string;
  /** Site path without the base. */
  path: string;
}
export interface ModuleReqs {
  n: number;
  title: string;
  items: Req[];
}
export interface ActReqs {
  n: number;
  title: string;
  modules: ModuleReqs[];
}

/** What the certificate page needs from the event store. */
export interface ProgressEvent {
  type: string;
  ref: string;
  payload?: Record<string, unknown>;
}

/** A lesson check counts as passed with at least this share of its questions right. */
export const CHECK_PASS_SHARE = 2 / 3;

export const BOSS_EVENTS = ["boss_1_star", "boss_2_star", "boss_3_star"] as const;
export const CERT_EVENTS = ["lesson_check", "classic_problem", ...BOSS_EVENTS] as const;

/** The refs of every requirement this device's events satisfy. Keys are `${kind}:${ref}`. */
export function metSet(events: ProgressEvent[]): Set<string> {
  const met = new Set<string>();
  for (const e of events) {
    if (e.type === "lesson_check") {
      const score = Number(e.payload?.score);
      const of = Number(e.payload?.of);
      // Older events without a score count: the check was taken, and nothing says it was failed.
      if (!Number.isFinite(score) || !Number.isFinite(of) || of <= 0 || score >= Math.ceil(of * CHECK_PASS_SHARE - 1e-9)) met.add(`check:${e.ref}`);
    } else if (e.type === "classic_problem") met.add(`problem:${e.ref}`);
    else if ((BOSS_EVENTS as readonly string[]).includes(e.type)) met.add(`boss:${e.ref}`);
  }
  return met;
}

export const isMet = (met: Set<string>, r: Req) => met.has(`${r.kind}:${r.ref}`);
export const actItems = (a: ActReqs) => a.modules.flatMap((m) => m.items);
export const actDone = (a: ActReqs, met: Set<string>) => actItems(a).every((r) => isMet(met, r));

export interface CertInput {
  name: string;
  /** "Act 2: Building blocks", or "the whole course". */
  scope: string;
  whole: boolean;
  modules: { n: number; title: string }[];
  counts: { checks: number; problems: number; bosses: string[] };
  /** Already formatted, e.g. "4 November 2026". */
  date: string;
  url: string;
}

export const CERT_W = 1600;
export const CERT_H = 1131;

/** Names are free text; keep them printable and short enough for one line. */
export const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

/** Greedy word wrap by an estimated character width. Good enough for a fixed-size image. */
function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && (line + " " + w).length > maxChars) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

const FONT = `font-family="Archivo, system-ui, -apple-system, 'Segoe UI', sans-serif"`;

export function certificateSvg(c: CertInput): string {
  const W = CERT_W;
  const H = CERT_H;
  const cx = W / 2;
  const name = cleanName(c.name) || "Learner";
  const nameSize = Math.round(Math.min(92, 1250 / Math.max(1, name.length * 0.56)));
  const range =
    c.modules.length === 0 ? "" : c.modules.length === 1 ? `Module ${c.modules[0]!.n}` : `Modules ${c.modules[0]!.n} to ${c.modules[c.modules.length - 1]!.n}`;
  const modLines = c.whole ? [`${range}, every act from Foundations to Mastery`] : wrap(`${range}: ${c.modules.map((m) => m.title).join(", ")}`, 74).slice(0, 3);
  const parts = [`${c.counts.checks} lesson check${c.counts.checks === 1 ? "" : "s"} passed`];
  if (c.counts.problems) parts.push(`${c.counts.problems} classic problem${c.counts.problems === 1 ? "" : "s"} solved`);
  if (c.counts.bosses.length) parts.push(`${c.counts.bosses.length === 1 ? "boss fight" : `${c.counts.bosses.length} boss fights`} won`);
  const text = (y: number, s: string, size: number, fill: string, extra = "") =>
    `<text x="${cx}" y="${y}" text-anchor="middle" ${FONT} font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const honesty = [
    "Self-reported progress on a free, open-source course. This is not an accredited credential:",
    "the progress was recorded in the learner's own browser and nobody has checked it.",
  ];
  let y = 640;
  const mods = modLines.map((l) => {
    const t = text(y, l, 30, "#4a5a72");
    y += 44;
    return t;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#edf1f4"/>
  <rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="24" fill="#ffffff" stroke="#cdd6df" stroke-width="3"/>
  <rect x="72" y="72" width="${W - 144}" height="${H - 144}" rx="14" fill="none" stroke="#2b59e0" stroke-width="2" stroke-dasharray="2 10" stroke-linecap="round"/>
  ${text(190, "System Design Quest", 34, "#2b59e0", 'font-weight="700" letter-spacing="1"')}
  ${text(290, "Certificate of completion", 76, "#15233b", 'font-weight="800"')}
  ${text(380, "This certificate is presented to", 30, "#4a5a72")}
  ${text(490, name, nameSize, "#15233b", 'font-weight="800"')}
  <line x1="${cx - 420}" y1="526" x2="${cx + 420}" y2="526" stroke="#cdd6df" stroke-width="2"/>
  ${text(588, c.whole ? "for completing the whole course" : `for completing ${c.scope}`, 38, "#15233b", 'font-weight="650"')}
  ${mods.join("\n  ")}
  ${text(y + 20, parts.join(", "), 30, "#138a64", 'font-weight="650"')}
  ${text(y + 70, `Issued ${c.date}`, 26, "#4a5a72")}
  <rect x="200" y="${H - 290}" width="${W - 400}" height="112" rx="12" fill="#f6f8fa" stroke="#cdd6df" stroke-width="1.5"/>
  ${honesty.map((l, i) => text(H - 244 + i * 38, l, 25, "#4a5a72")).join("\n  ")}
  <text x="120" y="${H - 110}" ${FONT} font-size="24" fill="#2b59e0">${esc(c.url)}</text>
  <text x="${W - 120}" y="${H - 110}" text-anchor="end" ${FONT} font-size="24" fill="#4a5a72">Developed and maintained by Aimbytes</text>
</svg>`;
}
