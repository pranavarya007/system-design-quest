/**
 * Build-time only (reads the file system): what each act asks of a learner before it can be certified.
 * The browser gets the result as island props; see lib/certificate.ts for how progress is checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { COURSE } from "../data/course";
import { lessonsIn } from "./lessons";
import type { ActReqs, Req } from "./certificate";

const learn = resolve(process.cwd(), "src/pages/learn");
const content = resolve(process.cwd(), "../../content");

function sourceOf(path: string): string {
  const rel = path.replace(/^\/learn\//, "").replace(/\/$/, "");
  for (const f of [resolve(learn, `${rel}.mdx`), resolve(learn, rel, "index.mdx")]) if (existsSync(f)) return readFileSync(f, "utf8");
  throw new Error(`Certificate: no MDX source for ${path}`);
}

/** The id field of a content YAML file (quiz `lesson`, practice or challenge `id`). */
function field(dir: string, name: string, key: string): string {
  const doc = parse(readFileSync(resolve(content, dir, `${name}.yaml`), "utf8")) as Record<string, unknown>;
  const v = doc[key];
  if (typeof v !== "string") throw new Error(`Certificate: content/${dir}/${name}.yaml has no ${key}`);
  return v;
}

export function certificateRequirements(): ActReqs[] {
  return COURSE.map((act, ai) => ({
    n: ai + 1,
    title: act.title,
    modules: act.modules.map((m) => {
      const items: Req[] = [];
      for (const l of lessonsIn(m.n)) {
        const src = sourceOf(l.path);
        const title = l.title.replace(/^Classic problem: /, "");
        for (const [, q] of src.matchAll(/<Check quiz="([^"]+)"/g)) items.push({ kind: "check", ref: field("quizzes", q!, "lesson"), title, path: l.path });
        for (const [, p] of src.matchAll(/<PracticeBlock id="([^"]+)"/g)) items.push({ kind: "problem", ref: field("practice", p!, "id"), title, path: l.path });
      }
      if (m.boss) {
        const slug = m.boss.path.replace(/\/$/, "").split("/").pop()!;
        items.push({ kind: "boss", ref: field("challenges", slug, "id"), title: m.boss.title, path: m.boss.path });
      }
      return { n: m.n, title: m.title, items };
    }),
  }));
}
