import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Herdr Core backend. Child subagents are Herdr terminals shown as panes.
 *
 * A "surface" is the child terminal id (for example `t42`). The pane id of
 * each child is kept in a module-level map because pane.split needs it.
 */

export type MuxBackend = "herdr";
export type LayoutMode = "split" | "tab";

// ---------------------------------------------------------------------------
// exec helper (single seam for tests; never uses a shell string)
// ---------------------------------------------------------------------------

export interface HcExec {
  sync(file: string, args: string[]): string;
  async(file: string, args: string[]): Promise<string>;
}

const defaultExec: HcExec = {
  sync: (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  async: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    }),
};

let exec: HcExec = defaultExec;

/** Test hook: replace the exec helper. Pass null to restore the default. */
export function __setHcExec(next: HcExec | null): void {
  exec = next ?? defaultExec;
}

function hc(args: string[]): string {
  return exec.sync("hc", args);
}

function herdrDo(command: string, args: string[]): string {
  return exec.sync("herdr-app", ["do", command, ...args]);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

function hasCommand(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export function getMuxBackend(): MuxBackend | null {
  if (!process.env.HC_TERMINAL_ID?.trim()) return null;
  if (!hasCommand("hc") || !hasCommand("herdr-app")) return null;
  return "herdr";
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  return "Run pi inside the Herdr app (HC_TERMINAL_ID must be set and `hc` and `herdr-app` must be on PATH).";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) throw new Error(`Herdr Core is not available. ${muxSetupHint()}`);
  return backend;
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// layout settings
// ---------------------------------------------------------------------------

export const SETTINGS_KEY = "hc-subagents";
const DEFAULT_MAX_SPLIT_CHILDREN = 4;

export interface LayoutSettings {
  layout: LayoutMode;
  maxSplitChildren: number;
  /** Extension files/package dirs for lean children. Unset = children inherit everything. */
  childExtensions?: string[];
}

export function parseLayoutSettings(raw: unknown): Partial<LayoutSettings> {
  const out: Partial<LayoutSettings> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.layout === "split" || r.layout === "tab") out.layout = r.layout;
  if (typeof r.maxSplitChildren === "number" && Number.isInteger(r.maxSplitChildren) && r.maxSplitChildren >= 0) {
    out.maxSplitChildren = r.maxSplitChildren;
  }
  if (Array.isArray(r.childExtensions)) {
    out.childExtensions = r.childExtensions.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  }
  return out;
}

function readSettingsFile(path: string): Partial<LayoutSettings> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parseLayoutSettings(parsed?.[SETTINGS_KEY]);
  } catch {
    return {};
  }
}

export function loadLayoutSettings(cwd: string = process.cwd()): LayoutSettings {
  let agentDir = "";
  try {
    agentDir = getAgentDir();
  } catch {}
  const global = agentDir ? readSettingsFile(join(agentDir, "settings.json")) : {};
  const project = readSettingsFile(join(cwd, ".pi", "settings.json"));
  return {
    layout: "split",
    maxSplitChildren: DEFAULT_MAX_SPLIT_CHILDREN,
    ...global,
    ...project,
  };
}

let settings: LayoutSettings | null = null;
let sessionLayout: LayoutMode | null = null;

function currentSettings(): LayoutSettings {
  settings ??= loadLayoutSettings();
  return settings;
}

/** Configured lean-child extension entries, or undefined when children inherit everything. */
export function getChildExtensionSettings(): string[] | undefined {
  return currentSettings().childExtensions;
}

export function getLayoutMode(): LayoutMode {
  return sessionLayout ?? currentSettings().layout;
}

/** Set the layout for NEW children for the rest of this session only. */
export function setLayoutMode(mode: LayoutMode): void {
  sessionLayout = mode;
}

export function getMaxSplitChildren(): number {
  return currentSettings().maxSplitChildren;
}

// ---------------------------------------------------------------------------
// topology helpers
// ---------------------------------------------------------------------------

interface TerminalLocation {
  terminalId: string;
  paneId: string;
  tabId: string;
  spaceId: string;
}

function readTopology(): Array<TerminalLocation & { tabName: string }> {
  const data = parseJson(exec.sync("herdr-app", ["ls"]));
  const out: Array<TerminalLocation & { tabName: string }> = [];
  for (const space of data?.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const term of tab.terminals ?? []) {
        out.push({
          terminalId: term.terminal,
          paneId: term.pane,
          tabId: tab.id,
          spaceId: space.id,
          tabName: tab.name,
        });
      }
    }
  }
  return out;
}

function locate(terminalId: string): (TerminalLocation & { tabName: string }) | null {
  return readTopology().find((t) => t.terminalId === terminalId) ?? null;
}

function locateParent(): TerminalLocation {
  const id = process.env.HC_TERMINAL_ID?.trim() ?? "";
  const found = locate(id);
  if (!found) throw new Error(`Could not find parent terminal ${id} in \`herdr-app ls\`.`);
  return found;
}

function extractId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.id === "string") return v.id;
  }
  return null;
}

const BASH_ARGV = ["/bin/bash", "--noprofile", "--norc"];

// ---------------------------------------------------------------------------
// surface creation
// ---------------------------------------------------------------------------

export interface SurfaceMeta {
  /** Agent name or undefined for none. */
  role?: string;
  /** Task text; truncated to 120 chars, single line. */
  task?: string;
}

const panes = new Map<string, string>(); // terminalId -> paneId
/** Live children placed in the split column, in creation order. */
let splitChildren: string[] = [];
let subagentsTab: { spaceId: string; tabId: string } | null = null;

/** Test hook: clear module state. */
export function __resetHcState(): void {
  panes.clear();
  splitChildren = [];
  subagentsTab = null;
  settings = null;
  sessionLayout = null;
}

/** Test hook: override loaded settings. */
export function __setHcSettings(next: Partial<LayoutSettings>): void {
  settings = { layout: "split", maxSplitChildren: DEFAULT_MAX_SPLIT_CHILDREN, ...next };
}

export function getSplitChildCount(): number {
  return splitChildren.length;
}

function createSplitChild(parent: TerminalLocation): string {
  const last = splitChildren[splitChildren.length - 1];
  const anchorPane = last ? (panes.get(last) ?? parent.paneId) : parent.paneId;
  const direction = last ? "down" : "right";
  const out = herdrDo("pane.split", [
    "--direction",
    direction,
    "--pane",
    anchorPane,
    "--argv",
    JSON.stringify(BASH_ARGV),
  ]);
  // Split always moves focus to the new pane: restore it at once.
  herdrDo("pane.focus", ["--pane", parent.paneId]);
  const parsed = parseJson(out);
  const paneId = extractId(parsed?.pane);
  const terminalId = extractId(parsed?.terminal);
  if (!paneId || !terminalId) throw new Error(`Unexpected pane.split output: ${out.trim()}`);
  panes.set(terminalId, paneId);
  splitChildren.push(terminalId);
  return terminalId;
}

function createTabChild(parent: TerminalLocation): string {
  let tabId = subagentsTab?.spaceId === parent.spaceId ? subagentsTab.tabId : null;
  if (tabId) {
    // The user may have closed the tab.
    if (!readTopology().some((t) => t.tabId === tabId)) tabId = null;
  }

  const labels = ["--label", `herdr.space=${parent.spaceId}`];
  if (tabId) labels.push("--label", `herdr.tab=${tabId}`);
  const out = hc(["run", "--bg", "--no-notify", "--json", ...labels, "--", ...BASH_ARGV]);
  // Terminal ids are not purely numeric (e.g. `t1z`); read the JSON address.
  const address = parseJson(out)?.address;
  const terminalId = typeof address === "string" && /^t[0-9a-z]+$/.test(address) ? address : undefined;
  if (!terminalId) throw new Error(`Unexpected hc run output: ${out.trim()}`);

  // `herdr-app ls` lags behind `hc run` by a moment: retry for up to ~3 s.
  let loc = locate(terminalId);
  for (let i = 0; !loc && i < 30; i++) {
    sleepSync(100);
    loc = locate(terminalId);
  }
  if (!loc) {
    try {
      hc(["kill", terminalId]);
      hc(["rm", terminalId]);
    } catch {}
  }
  if (!loc) throw new Error(`Terminal ${terminalId} not found in \`herdr-app ls\` after hc run.`);
  panes.set(terminalId, loc.paneId);

  if (!tabId) {
    subagentsTab = { spaceId: parent.spaceId, tabId: loc.tabId };
    herdrDo("tab.rename", ["--id", loc.tabId, "--name", "Subagents"]);
  }
  return terminalId;
}

function applyLabels(terminalId: string, name: string, meta?: SurfaceMeta): void {
  const task = (meta?.task ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  hc([
    "label",
    terminalId,
    "pi.subagent=1",
    `pi.role=${meta?.role?.trim() || "none"}`,
    `pi.name=${name.replace(/\s+/g, " ").trim()}`,
    `pi.parent=${process.env.HC_TERMINAL_ID ?? ""}`,
    `pi.task=${task}`,
  ]);
}

/**
 * Create a child terminal. Returns the terminal id (the surface id).
 * The child runs a clean bash; the caller then sends the real command.
 */
export function createSurface(name: string, meta?: SurfaceMeta): string {
  requireMuxBackend();
  const parent = locateParent();
  const useSplit = getLayoutMode() === "split" && splitChildren.length < getMaxSplitChildren();
  const terminalId = useSplit ? createSplitChild(parent) : createTabChild(parent);
  applyLabels(terminalId, name, meta);
  return terminalId;
}

export function renameCurrentTab(title: string): void {
  requireMuxBackend();
  herdrDo("tab.rename", ["--id", locateParent().tabId, "--name", title]);
}

export function renameWorkspace(title: string): void {
  requireMuxBackend();
  herdrDo("space.rename", ["--id", locateParent().spaceId, "--name", title]);
}

// ---------------------------------------------------------------------------
// terminal I/O
// ---------------------------------------------------------------------------

export function sendCommand(surface: string, command: string): void {
  requireMuxBackend();
  hc(["send", surface, command]);
}

export function sendEscape(surface: string): void {
  requireMuxBackend();
  hc(["keys", surface, "esc"]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  requireMuxBackend();
  return hc(["read", surface, "--lines", String(lines)]);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMuxBackend();
  return exec.async("hc", ["read", surface, "--lines", String(lines)]);
}

/** Kill the child terminal; Herdr closes its pane with it. */
export function closeSurface(surface: string): void {
  requireMuxBackend();
  splitChildren = splitChildren.filter((t) => t !== surface);
  panes.delete(surface);
  hc(["kill", surface]);
  // A killed terminal lingers as `finished` (keep:true) until removed.
  try {
    hc(["rm", surface]);
  } catch {}
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Report passed to subagent_done via `summary`, if any */
  summary?: string;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  const summary =
    typeof data?.summary === "string" && data.summary.trim() !== "" ? data.summary : undefined;
  return { reason: "done", exitCode: 0, ...(summary ? { summary } : {}) };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

