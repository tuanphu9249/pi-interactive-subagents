import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Lean child extension resolution. Pure helpers (no Pi imports) so they are
 * easy to test.
 */

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Parse frontmatter `extensions:` value: comma list, [a, b], or YAML block list. */
export function parseExtensionsField(frontmatter: string): string[] | undefined {
  const lines = frontmatter.split("\n");
  const idx = lines.findIndex((l) => /^extensions:/.test(l));
  if (idx < 0) return undefined;
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  const inline = lines[idx].replace(/^extensions:\s*/, "").trim();
  const out: string[] = [];
  if (inline) {
    const body = inline.replace(/^\[/, "").replace(/\]$/, "");
    for (const s of body.split(",")) out.push(clean(s));
  } else {
    for (let i = idx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s+(.*)$/);
      if (!m) break;
      out.push(clean(m[1]));
    }
  }
  return out.filter(Boolean);
}

/**
 * Resolve entries (files or package dirs) to absolute extension file paths.
 * Skips missing entries (warn) and anything equal to `selfPath` (no nesting).
 */
export function resolveChildExtensions(
  entries: string[],
  opts: { selfPath: string; warn: (msg: string) => void },
): string[] {
  const self = canonical(opts.selfPath);
  const out: string[] = [];
  const add = (p: string) => {
    if (canonical(p) === self) return;
    if (!out.includes(p)) out.push(p);
  };
  for (const raw of entries) {
    const p = resolve(expandHome(raw));
    if (!existsSync(p)) {
      opts.warn(`hc-subagents: child extension not found, skipping: ${raw}`);
      continue;
    }
    if (!statSync(p).isDirectory()) {
      add(p);
      continue;
    }
    let exts: unknown;
    try {
      exts = JSON.parse(readFileSync(join(p, "package.json"), "utf8"))?.pi?.extensions;
    } catch {}
    if (!Array.isArray(exts)) {
      opts.warn(`hc-subagents: no package.json with pi.extensions in ${raw}, skipping`);
      continue;
    }
    for (const e of exts) {
      if (typeof e !== "string") continue;
      const ep = resolve(p, e);
      if (existsSync(ep)) add(ep);
      else opts.warn(`hc-subagents: child extension not found, skipping: ${ep}`);
    }
  }
  return out;
}
