/**
 * Rex label store. A Rex block has one text label, not key=value labels, so the
 * `pi.*` labels that Herdr keeps on a terminal go to one JSON file per block.
 * The Rex session strip reads these files.
 *
 * Directory: `$XDG_STATE_HOME/pi-subagents/rex-labels/`, or
 * `~/.local/state/pi-subagents/rex-labels/`. Mode 0700.
 * File: `<block id with ":" replaced by "_">.json`, mode 0600, 16 KiB max:
 *   {"version":1,"block_id":"block:…","labels":{"pi.subagent":"1",…},"updated":<ms>}
 *
 * Writes never follow symlinks and go through a temporary file plus rename.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REX_LABELS_MAX_BYTES = 16 * 1024;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Directories already swept for stale files by this process. */
const swept = new Set<string>();
const BLOCK_ID_RE = /^block:[0-9A-Za-z-]+$/;

export function rexLabelsDir(): string {
  const state = process.env.XDG_STATE_HOME?.trim();
  return join(state ? state : join(homedir(), ".local", "state"), "pi-subagents", "rex-labels");
}

/** File path for a block id. Throws when the id is not `block:<id>`. */
export function rexLabelsFile(blockId: string): string {
  if (!BLOCK_ID_RE.test(blockId)) throw new Error(`Invalid Rex block id: ${blockId}`);
  return join(rexLabelsDir(), `${blockId.replace(":", "_")}.json`);
}

const myUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** Create the directory when it is missing (mode 0700). Throws when it is not safe to use. */
function ensureDir(): string {
  const dir = rexLabelsDir();
  let st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) {
    mkdirSync(join(dir, ".."), { recursive: true });
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unsafe Rex label directory: ${dir}`);
  const uid = myUid();
  if (uid !== null && st.uid !== uid) throw new Error(`Rex label directory is not owned by this user: ${dir}`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  if (!swept.has(dir)) {
    // Once per process and directory: drop files that no live block has touched for 7 days.
    swept.add(dir);
    removeStaleFiles(dir);
  }
  return dir;
}

function removeStaleFiles(dir: string): void {
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const st = lstatSync(join(dir, name), { throwIfNoEntry: false });
      if (st?.isFile() && st.mtimeMs < cutoff) rmSync(join(dir, name), { force: true });
    }
  } catch {}
}

/** Read one file without following a symlink. Null when it is missing or not a usable file. */
function readRaw(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const uid = myUid();
    if (!st.isFile() || st.size > REX_LABELS_MAX_BYTES || (uid !== null && st.uid !== uid)) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseLabels(text: string | null, blockId: string): Record<string, string> | null {
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || data.block_id !== blockId || !data.labels || typeof data.labels !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.labels)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** Labels stored for a block, or null when there is no valid file. */
export function readRexLabels(blockId: string): Record<string, string> | null {
  return parseLabels(readRaw(rexLabelsFile(blockId)), blockId);
}

/**
 * Merge `labels` into the block's file. An empty value deletes that key. Throws
 * when the directory is unsafe, the block id is invalid, or the result is over 16 KiB.
 */
export function writeRexLabels(blockId: string, labels: Record<string, string>): void {
  const file = rexLabelsFile(blockId);
  const dir = ensureDir();
  const merged = parseLabels(readRaw(file), blockId) ?? {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  const body = JSON.stringify({ version: 1, block_id: blockId, labels: merged, updated: Date.now() });
  if (Buffer.byteLength(body) > REX_LABELS_MAX_BYTES) throw new Error(`Rex labels for ${blockId} exceed 16 KiB`);

  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, body);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Delete the block's file. Never throws. */
export function removeRexLabels(blockId: string): void {
  try {
    rmSync(rexLabelsFile(blockId), { force: true });
  } catch {}
}
