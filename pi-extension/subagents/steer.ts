import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Inbox: parent -> child steer messages (append-only JSONL, one message per line)
// ---------------------------------------------------------------------------

export interface InboxMessage {
  /** Monotonic per-inbox sequence number, starting at 1. */
  id: number;
  text: string;
  at: number;
}

export function getSubagentInboxFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-inbox", `${runningChildId}.jsonl`);
}

/** Parse complete JSONL lines; ignores blank or malformed lines. */
export function parseInboxLines(text: string): InboxMessage[] {
  const messages: InboxMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (Number.isInteger(value?.id) && typeof value?.text === "string") {
        messages.push({ id: value.id, text: value.text, at: Number(value.at) || 0 });
      }
    } catch {
      // A torn or foreign line must not break delivery of later messages.
    }
  }
  return messages;
}

/** Parent side: append a message and return its id. */
export function appendInboxMessage(inboxFile: string, text: string, now: number = Date.now()): number {
  mkdirSync(dirname(inboxFile), { recursive: true });
  const existing = existsSync(inboxFile) ? parseInboxLines(readFileSync(inboxFile, "utf8")) : [];
  const id = existing.reduce((max, message) => Math.max(max, message.id), 0) + 1;
  appendFileSync(inboxFile, `${JSON.stringify({ id, text, at: now })}\n`, "utf8");
  return id;
}

/**
 * Child side: returns a `poll()` that delivers each new inbox message exactly
 * once, in id order. Only newline-terminated lines are consumed, so a message
 * that is still being written is picked up by a later poll.
 */
export function createInboxConsumer(params: {
  inboxFile: string;
  deliver: (message: InboxMessage) => void;
  onDelivered?: (message: InboxMessage) => void;
}): { poll(): void } {
  let lastDeliveredId = 0;

  return {
    poll() {
      let content: string;
      try {
        if (!existsSync(params.inboxFile)) return;
        content = readFileSync(params.inboxFile, "utf8");
      } catch {
        return;
      }
      const complete = content.slice(0, content.lastIndexOf("\n") + 1);
      const fresh = parseInboxLines(complete)
        .filter((message) => message.id > lastDeliveredId)
        .sort((a, b) => a.id - b.id);
      for (const message of fresh) {
        lastDeliveredId = message.id;
        try {
          params.deliver(message);
          params.onDelivered?.(message);
        } catch {
          // Never throw out of the poll loop.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// pi.activity label (child side)
// ---------------------------------------------------------------------------

export const ACTIVITY_LABEL_MAX = 80;
export const ACTIVITY_LABEL_MIN_INTERVAL_MS = 2000;

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** Text for a running tool, e.g. `bash: npm test`, `read: hc.ts`. One line, max 80 chars. */
export function formatToolActivity(toolName: string | undefined, args: any): string {
  const name = oneLine(toolName) || "tool";
  let detail = "";
  if (args && typeof args === "object") {
    if (typeof args.command === "string") detail = oneLine(args.command);
    else if (typeof args.path === "string") detail = basename(oneLine(args.path));
    else if (typeof args.file_path === "string") detail = basename(oneLine(args.file_path));
    else if (typeof args.pattern === "string") detail = oneLine(args.pattern);
    else if (typeof args.query === "string") detail = oneLine(args.query);
    else if (typeof args.name === "string") detail = oneLine(args.name);
  }
  const text = detail ? `${name}: ${detail}` : name;
  return text.length <= ACTIVITY_LABEL_MAX ? text : `${text.slice(0, ACTIVITY_LABEL_MAX - 1)}…`;
}

/**
 * Throttled, change-only writer for the `pi.activity` label. `run` starts the
 * write asynchronously (it must not block); failures are swallowed.
 */
export function createActivityLabelWriter(params: {
  run: (text: string) => Promise<unknown> | void;
  now?: () => number;
  minIntervalMs?: number;
}): { set(text: string): void; flush(): void } {
  const now = params.now ?? (() => Date.now());
  const minIntervalMs = params.minIntervalMs ?? ACTIVITY_LABEL_MIN_INTERVAL_MS;
  let lastWritten: string | undefined;
  let lastWriteAt = -Infinity;
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function write(text: string): void {
    lastWritten = text;
    lastWriteAt = now();
    try {
      Promise.resolve(params.run(text)).catch(() => {});
    } catch {
      // hc missing or failing: skip silently
    }
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = pending;
    pending = undefined;
    if (text != null && text !== lastWritten) write(text);
  }

  return {
    set(raw: string) {
      const text = oneLine(raw).slice(0, ACTIVITY_LABEL_MAX);
      if (!text) return;
      if (text === lastWritten) {
        pending = undefined; // back to the written value: drop any queued change
        return;
      }
      pending = text;
      const wait = minIntervalMs - (now() - lastWriteAt);
      if (wait <= 0) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, wait);
        timer.unref?.();
      }
    },
    flush,
  };
}
