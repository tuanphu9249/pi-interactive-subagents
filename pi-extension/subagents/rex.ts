/**
 * Rex backend. Child subagents are Rex terminal blocks in the parent's Rex session.
 *
 * A "surface" is the child's full block id (for example `block:01a1...`). The
 * session is `$REX_SESSION`; the parent block is `$REX_BLOCK`.
 *
 * Every call goes through the `exec` passed in by hc.ts (one test seam, argument
 * arrays only, never a shell string).
 */

export interface RexExec {
  sync(file: string, args: string[]): string;
  async(file: string, args: string[]): Promise<string>;
}

export interface RexLayout {
  layout: "split" | "tab";
  maxSplitChildren: number;
  /** Share of the width the child column takes (0.1..0.9). */
  splitRatio: number;
}

/** The program each child block starts. The caller then sends the real command. */
const CHILD_ARGV = ["/bin/bash", "--noprofile", "--norc"];
const TAB_LABEL = "Subagents";

/** Live children placed in the split column, in creation order. */
let splitChildren: string[] = [];
/** Live children in the Subagents tab, in creation order. Empty = no tab yet. */
let tabChildren: string[] = [];

export function __resetRexState(): void {
  splitChildren = [];
  tabChildren = [];
}

export function getRexSplitChildCount(): number {
  return splitChildren.length;
}

export function rexSession(): string {
  return process.env.REX_SESSION?.trim() ?? "";
}

export function rexParentBlock(): string {
  return process.env.REX_BLOCK?.trim() ?? "";
}

/** True when this process runs in a Rex terminal. `rex` on PATH is checked by the caller. */
export function hasRexEnv(): boolean {
  return rexSession() !== "" && rexParentBlock() !== "";
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstBlock(out: string, what: string): string {
  const id = parseJson(out)?.block_ids?.[0];
  if (typeof id !== "string" || id === "") throw new Error(`Unexpected rex ${what} output: ${out.trim()}`);
  return id;
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Block ids in the session, or null when the list cannot be read. */
function listBlocks(exec: RexExec): Set<string> | null {
  try {
    const data = parseJson(exec.sync("rex", ["block", "ls", "-s", rexSession(), "--json"]));
    const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.blocks) ? data.blocks : [];
    const ids = new Set<string>();
    for (const b of items) {
      const id = b?.block_id ?? b?.id;
      if (typeof id === "string") ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

function createSplitChild(exec: RexExec, label: string, ratio: number): string {
  const last = splitChildren[splitChildren.length - 1];
  const anchor = last ?? rexParentBlock();
  // The first child takes `ratio` of the parent's width on the right. Later
  // children stack below the last one and share its height.
  const args = [
    "split",
    "-s",
    rexSession(),
    "-b",
    anchor,
    `--split=${last ? "below" : "right"}`,
    "--ratio",
    String(last ? 50 : Math.round(ratio * 100)),
    "--focus=false",
    "--label",
    label,
    "--json",
    "--",
    ...CHILD_ARGV,
  ];
  const block = firstBlock(exec.sync("rex", args), "split");
  splitChildren.push(block);
  return block;
}

function createTabChild(exec: RexExec, label: string): string {
  if (tabChildren.length > 0) {
    // The user may have closed blocks or the whole tab.
    const blocks = listBlocks(exec);
    if (blocks) tabChildren = tabChildren.filter((b) => blocks.has(b));
  }
  const anchor = tabChildren[tabChildren.length - 1];
  if (anchor) {
    const args = [
      "split",
      "-s",
      rexSession(),
      "-b",
      anchor,
      "--split=below",
      "--focus=false",
      "--label",
      label,
      "--json",
      "--",
      ...CHILD_ARGV,
    ];
    const block = firstBlock(exec.sync("rex", args), "split");
    tabChildren.push(block);
    return block;
  }
  const out = exec.sync("rex", ["window", "new", "-s", rexSession(), TAB_LABEL, "--focus=false", "--json", "--", ...CHILD_ARGV]);
  const block = firstBlock(out, "window new");
  tabChildren.push(block);
  setBlockLabel(exec, block, label);
  return block;
}

function setBlockLabel(exec: RexExec, block: string, label: string): void {
  try {
    exec.sync("rex", [
      "api",
      "call",
      "-s",
      rexSession(),
      "session.set_block_label",
      JSON.stringify({ block_id: block, label }),
    ]);
  } catch {}
}

/** Create a child block. Returns its block id (the surface id). */
export function rexCreateSurface(exec: RexExec, name: string, layout: RexLayout): string {
  const label = oneLine(name, 128) || "subagent";
  const useSplit = layout.layout === "split" && splitChildren.length < layout.maxSplitChildren;
  return useSplit ? createSplitChild(exec, label, layout.splitRatio) : createTabChild(exec, label);
}

/** Type `command` and press Return. */
export function rexSendCommand(exec: RexExec, surface: string, command: string): void {
  exec.sync("rex", ["send", "-s", rexSession(), "-b", surface, command]);
  exec.sync("rex", ["send-key", "-s", rexSession(), "-b", surface, "enter"]);
}

export function rexSendEscape(exec: RexExec, surface: string): void {
  exec.sync("rex", ["send-key", "-s", rexSession(), "-b", surface, "escape"]);
}

/** The last `lines` lines of the screen (trailing blank lines removed). */
export function lastLines(text: string, lines: number): string {
  const all = text.replace(/\n+$/, "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function captureArgs(surface: string): string[] {
  return ["capture", "-s", rexSession(), "-b", surface, "--trim"];
}

export function rexReadScreen(exec: RexExec, surface: string, lines: number): string {
  return lastLines(exec.sync("rex", captureArgs(surface)), lines);
}

export async function rexReadScreenAsync(exec: RexExec, surface: string, lines: number): Promise<string> {
  return lastLines(await exec.async("rex", captureArgs(surface)), lines);
}

/** Close the child block and end its program. */
export function rexCloseSurface(exec: RexExec, surface: string): void {
  splitChildren = splitChildren.filter((b) => b !== surface);
  tabChildren = tabChildren.filter((b) => b !== surface);
  exec.sync("rex", ["block", "close", "-s", rexSession(), surface]);
}
