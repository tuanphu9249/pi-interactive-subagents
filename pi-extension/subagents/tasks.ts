/**
 * Session task list (the `task` tool).
 *
 * One list per Pi session. Only the parent session writes: children get no
 * `task` tool. The fork changes a status itself when a child that was spawned
 * with `taskId` starts, finishes, fails or is stopped.
 *
 * Storage: `task` tool results carry the full snapshot in `details`. Changes
 * made outside a `task` call are stored as a `task-snapshot` custom entry
 * (`pi.appendEntry`). On session start and branch change the list is rebuilt
 * from the last snapshot on the current branch.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SNAPSHOT_ENTRY = "task-snapshot";
export const TASK_TOOL_NAME = "task";
export const SUBJECT_LABEL_MAX = 80;

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  /** Child name and id, e.g. `Worker (ab12cd34)`. */
  owner?: string;
  activeForm?: string;
}

export interface TaskSnapshot {
  tasks: Task[];
  nextId: number;
}

export interface TaskToolParams {
  action: "create" | "update" | "get" | "list";
  id?: string;
  subject?: string;
  description?: string;
  status?: string;
  blockedBy?: string[];
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  owner?: string;
  activeForm?: string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normId(value: unknown): string {
  return String(value ?? "").trim().replace(/^#/, "");
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export class TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  snapshot(): TaskSnapshot {
    return { tasks: this.tasks.map((t) => ({ ...t, blockedBy: [...t.blockedBy] })), nextId: this.nextId };
  }

  load(snapshot: TaskSnapshot | null): void {
    if (!snapshot) {
      this.tasks = [];
      this.nextId = 1;
      return;
    }
    this.tasks = snapshot.tasks.map((t) => ({ ...t, blockedBy: [...(t.blockedBy ?? [])] }));
    this.nextId = snapshot.nextId;
  }

  all(): Task[] {
    return this.snapshot().tasks;
  }

  get(id: string): Task | undefined {
    const found = this.tasks.find((t) => t.id === normId(id));
    return found ? { ...found, blockedBy: [...found.blockedBy] } : undefined;
  }

  private require(id: string): Task {
    const key = normId(id);
    if (!key) throw new Error("id is required.");
    const found = this.tasks.find((t) => t.id === key);
    if (!found) throw new Error(`Unknown task id "${key}".`);
    return found;
  }

  /** A task is ready when it is pending and every blocker is completed. */
  isReady(task: Task): boolean {
    if (task.status !== "pending") return false;
    return task.blockedBy.every((b) => this.tasks.find((t) => t.id === b)?.status === "completed");
  }

  private checkBlockers(selfId: string | null, ids: string[]): string[] {
    const out: string[] = [];
    for (const raw of ids) {
      const id = normId(raw);
      if (!this.tasks.some((t) => t.id === id)) throw new Error(`Unknown blocker "${id}".`);
      if (selfId !== null && this.dependsOn(id, selfId)) {
        throw new Error(
          id === selfId ? `Dependency cycle: #${id} cannot block itself.` : `Dependency cycle: #${id} already depends on #${selfId}.`,
        );
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** True when `from` equals `target` or reaches it through blockedBy links. */
  private dependsOn(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const task = this.tasks.find((t) => t.id === cur);
      if (task) stack.push(...task.blockedBy);
    }
    return false;
  }

  create(input: { subject?: string; description?: string; blockedBy?: string[] }): Task {
    const subject = oneLine(input.subject ?? "");
    if (!subject) throw new Error("subject is required.");
    const blockedBy = this.checkBlockers(null, input.blockedBy ?? []);
    const task: Task = { id: String(this.nextId), subject, status: "pending", blockedBy };
    if (input.description) task.description = input.description;
    this.nextId += 1;
    this.tasks.push(task);
    return { ...task, blockedBy: [...task.blockedBy] };
  }

  update(input: {
    id?: string;
    status?: string;
    subject?: string;
    description?: string;
    addBlockedBy?: string[];
    removeBlockedBy?: string[];
    owner?: string;
    activeForm?: string;
  }): Task {
    const task = this.require(input.id ?? "");
    if (input.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`Unknown status "${input.status}". Use ${TASK_STATUSES.join(", ")}.`);
    }
    if (input.subject !== undefined && !oneLine(input.subject)) throw new Error("subject must not be empty.");
    const add = this.checkBlockers(task.id, input.addBlockedBy ?? []);
    // All checks passed: apply.
    if (input.status !== undefined) task.status = input.status as TaskStatus;
    if (input.subject !== undefined) task.subject = oneLine(input.subject);
    if (input.description !== undefined) task.description = input.description;
    if (input.owner !== undefined) {
      if (input.owner) task.owner = input.owner;
      else delete task.owner;
    }
    if (input.activeForm !== undefined) {
      if (input.activeForm) task.activeForm = input.activeForm;
      else delete task.activeForm;
    }
    const remove = new Set((input.removeBlockedBy ?? []).map(normId));
    task.blockedBy = task.blockedBy.filter((b) => !remove.has(b));
    for (const b of add) if (!task.blockedBy.includes(b)) task.blockedBy.push(b);
    return { ...task, blockedBy: [...task.blockedBy] };
  }

  /** A child starts the task: pending -> in_progress, owner = child. */
  claim(id: string, owner: string): Task {
    const task = this.require(id);
    if (task.status !== "pending") {
      throw new Error(`Task #${task.id} is ${task.status}, not pending.`);
    }
    task.status = "in_progress";
    task.owner = owner;
    return { ...task, blockedBy: [...task.blockedBy] };
  }

  /** Automatic end state. Applies only while the task is in_progress. */
  settle(id: string, status: TaskStatus): Task | null {
    const task = this.tasks.find((t) => t.id === normId(id));
    if (!task || task.status !== "in_progress") return null;
    task.status = status;
    return { ...task, blockedBy: [...task.blockedBy] };
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export function countTasks(tasks: Task[]): { completed: number; total: number } {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  return { completed: counted.filter((t) => t.status === "completed").length, total: counted.length };
}

export function formatTaskLine(task: Task, ready: boolean): string {
  const blocked = task.blockedBy.length ? ` blockedBy: ${task.blockedBy.map((b) => `#${b}`).join(",")}` : "";
  const owner = task.owner ? ` owner: ${task.owner}` : "";
  const flag = ready ? " ready" : "";
  return `#${task.id} [${task.status}]${flag} ${task.subject}${owner}${blocked}`;
}

export function formatTaskList(store: TaskStore): string {
  const tasks = store.all();
  if (tasks.length === 0) return "No tasks.";
  return tasks.map((t) => formatTaskLine(t, store.isReady(t))).join("\n");
}

export interface TaskWidgetStyle {
  /** Strike text through. Default: identity. */
  strike?: (text: string) => string;
  /** Dim a whole row (completed, blocked, fold). Default: identity. */
  dim?: (text: string) => string;
  /** Accent colour: box border and in-progress rows. Default: identity. */
  accent?: (text: string) => string;
  /** Error colour: failed rows. Default: identity. */
  error?: (text: string) => string;
}

/** Narrowest width that still fits the top border `╭─ Tasks ─ N/M done ─╮`; below it the widget is unboxed. */
export const TASK_BOX_MIN_WIDTH = 24;

function rowsFor(
  store: TaskStore,
  maxLines: number,
  style: TaskWidgetStyle,
): { rows: string[]; completed: number; total: number } | undefined {
  const strike = style.strike ?? ((t: string) => t);
  const dim = style.dim ?? ((t: string) => t);
  const accent = style.accent ?? ((t: string) => t);
  const error = style.error ?? ((t: string) => t);
  if (store.all().length === 0) return undefined;
  const tasks = store.all().filter((t) => t.status !== "cancelled");
  const { completed, total } = countTasks(store.all());
  const room = Math.max(0, maxLines);

  const rowFor = (t: Task): string => {
    switch (t.status) {
      case "completed":
        return dim(`✓ ${strike(`#${t.id} ${t.subject}`)}`);
      case "in_progress":
        return accent(`▶ #${t.id} ${t.activeForm || t.subject}${t.owner ? ` (${t.owner})` : ""}`);
      case "failed":
        return error(`✗ #${t.id} ${t.subject}`);
      default:
        return store.isReady(t)
          ? `○ #${t.id} ${t.subject}`
          : dim(`· #${t.id} ${t.subject} (blocked by ${t.blockedBy.map((b) => `#${b}`).join(",")})`);
    }
  };

  const done = tasks.filter((t) => t.status === "completed");
  const open = tasks.filter((t) => t.status !== "completed");

  if (open.length > room) {
    const rank = (t: Task) =>
      t.status === "in_progress" ? 0 : t.status === "failed" ? 1 : store.isReady(t) ? 2 : 3;
    const ordered = [...open].sort((a, b) => rank(a) - rank(b));
    const shown = ordered.slice(0, Math.max(0, room - 1)).map(rowFor);
    const rows = [...shown, `… +${open.length - shown.length} more`].slice(0, room);
    return { rows, completed, total };
  }

  const slots = room - open.length;
  let dropped = 0;
  let keep = done;
  if (done.length > slots) {
    const kept = Math.max(0, slots - 1);
    dropped = done.length - kept;
    keep = done.slice(done.length - kept);
  }
  const keepIds = new Set([...keep, ...open].map((t) => t.id));
  const rows = tasks.filter((t) => keepIds.has(t.id)).map(rowFor);
  // No free row (open tasks fill the room): drop the `✓ N done` line too; the box info still counts them.
  const doneLine = dropped > 0 && slots > 0 ? [dim(`✓ ${dropped} done`)] : [];
  return { rows: [...doneLine, ...rows], completed, total };
}

/**
 * Task rows (no header), in id order (checklist):
 * ✓ completed (struck, dim), ▶ in_progress (accent), ○ ready, · blocked (dim), ✗ failed (error). Cancelled tasks are hidden.
 * At most `maxLines` rows. Open tasks (not completed) always win room. If room is short,
 * the oldest completed tasks drop first and one `✓ N done` row replaces them.
 * If open tasks alone overflow, show the first ones (in_progress, failed, ready, blocked) and `… +N more`.
 * Returns undefined when the store is empty.
 */
export function renderTaskWidgetLines(
  store: TaskStore,
  maxLines = 7,
  style: TaskWidgetStyle = {},
): string[] | undefined {
  return rowsFor(store, maxLines, style)?.rows;
}

/**
 * Task widget as a box like the subagent widget:
 *   ╭─ Tasks ──────── 3/7 done ─╮
 *   │ ✓ #1 a                    │
 *   ╰───────────────────────────╯
 * Border in the accent colour; rows cut and padded to `width`. The box has at most `maxLines` rows
 * plus two borders. Below TASK_BOX_MIN_WIDTH the widget is unboxed: a `Tasks N/M` line, then the rows,
 * each cut to `width`. Returns undefined when the store is empty.
 */
export function renderTaskWidgetBox(
  store: TaskStore,
  width: number,
  style: TaskWidgetStyle = {},
  maxLines = 7,
): string[] | undefined {
  const res = rowsFor(store, maxLines, style);
  if (!res) return undefined;
  if (width <= 0) return [];
  const accent = style.accent ?? ((t: string) => t);
  const { rows, completed, total } = res;

  if (width < TASK_BOX_MIN_WIDTH) {
    return [`Tasks ${completed}/${total}`, ...rows].map((l, i) =>
      truncateToWidth(i === 0 ? accent(l) : l, width),
    );
  }

  const inner = width - 2;
  const titlePart = "─ Tasks ";
  const infoPart = ` ${completed}/${total} done ─`;
  const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
  const bar = accent("│");
  const lines = [accent(`╭${titlePart}${fill}${infoPart}╮`)];
  for (const row of rows) {
    const cut = truncateToWidth(row, inner - 2);
    lines.push(`${bar} ${cut}${" ".repeat(Math.max(0, inner - 2 - visibleWidth(cut)))} ${bar}`);
  }
  lines.push(accent(`╰${"─".repeat(inner)}╯`));
  return lines;
}

/** Labels for the parent terminal. Empty string means: remove the label. */
export function computeParentLabels(tasks: Task[]): { "pi.tasks": string; "pi.tasknow": string } {
  if (tasks.length === 0) return { "pi.tasks": "", "pi.tasknow": "" };
  const { completed, total } = countTasks(tasks);
  const now = tasks.filter((t) => t.status === "in_progress" && !t.owner);
  let tasknow = "";
  if (now.length) {
    tasknow = oneLine(`#${now[0].id} ${now[0].subject}`);
    if (now.length > 1) tasknow += ` +${now.length - 1}`;
  }
  return { "pi.tasks": `${completed}/${total}`, "pi.tasknow": tasknow };
}

/** Labels for a child terminal started with `taskId`. */
export function childTaskLabels(task: Pick<Task, "id" | "subject">): Record<string, string> {
  return { "pi.taskid": task.id, "pi.tasksubject": oneLine(task.subject).slice(0, SUBJECT_LABEL_MAX) };
}

// ---------------------------------------------------------------------------
// snapshot recovery
// ---------------------------------------------------------------------------

function asSnapshot(value: any): TaskSnapshot | null {
  if (!value || !Array.isArray(value.tasks) || typeof value.nextId !== "number") return null;
  return { tasks: value.tasks, nextId: value.nextId };
}

/** Last snapshot on a branch: a `task` tool result or a `task-snapshot` custom entry. */
export function findLastSnapshot(entries: readonly any[]): TaskSnapshot | null {
  let found: TaskSnapshot | null = null;
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === TASK_TOOL_NAME) {
      found = asSnapshot(entry.message.details) ?? found;
    } else if (entry?.type === "custom" && entry.customType === TASK_SNAPSHOT_ENTRY) {
      found = asSnapshot(entry.data) ?? found;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

export interface TaskControllerDeps {
  /** Persist a snapshot as a session custom entry. */
  appendEntry?: (customType: string, data: unknown) => void;
  /** Set or clear (undefined) the widget above the editor. */
  setWidget?: (render: ((width: number, style: TaskWidgetStyle) => string[]) | undefined) => void;
  /** Write labels on a terminal. Empty value removes the label. May throw. */
  writeLabels?: (terminalId: string, labels: Record<string, string>) => void;
  /** Parent terminal id (`$HC_TERMINAL_ID`). */
  parentTerminal?: () => string | undefined;
}

export interface TaskToolResult {
  content: { type: "text"; text: string }[];
  details: TaskSnapshot & { action: string; error?: string; taskId?: string };
}

export class TaskController {
  readonly store = new TaskStore();
  private lastLabels: string | null = null;

  private deps: TaskControllerDeps;

  constructor(deps: TaskControllerDeps = {}) {
    this.deps = deps;
  }

  /** Replace deps (the UI context changes per session). */
  setDeps(deps: TaskControllerDeps): void {
    this.deps = deps;
  }

  /** Rebuild from the current branch, then refresh widget and labels. */
  rebuild(entries: readonly any[]): void {
    this.store.load(findLastSnapshot(entries));
    this.lastLabels = null;
    this.refresh();
  }

  /** Update widget and parent labels. Never throws. */
  refresh(): void {
    try {
      const has = this.store.all().length > 0;
      this.deps.setWidget?.(
        has ? (width, style) => renderTaskWidgetBox(this.store, width, style) ?? [] : undefined,
      );
    } catch {}
    this.writeParentLabels();
  }

  private writeParentLabels(): void {
    const terminal = this.deps.parentTerminal?.()?.trim();
    if (!terminal || !this.deps.writeLabels) return;
    const labels = computeParentLabels(this.store.all());
    const key = JSON.stringify(labels);
    if (key === this.lastLabels) return;
    try {
      this.deps.writeLabels(terminal, labels);
      this.lastLabels = key;
    } catch {
      this.lastLabels = null;
    }
  }

  private persist(): void {
    try {
      this.deps.appendEntry?.(TASK_SNAPSHOT_ENTRY, this.store.snapshot());
    } catch {}
  }

  /** Spawn with `taskId`. Throws when the task is unknown or not pending. */
  claim(id: string, owner: string): Task {
    const task = this.store.claim(id, owner);
    this.persist();
    this.refresh();
    return task;
  }

  /** A claim could not be used (launch failed): back to pending. */
  release(id: string): void {
    try {
      this.store.update({ id, status: "pending", owner: "" });
    } catch {
      return;
    }
    this.persist();
    this.refresh();
  }

  /** Set the child owner after launch. */
  setOwner(id: string, owner: string): void {
    try {
      this.store.update({ id, owner });
    } catch {
      return;
    }
    this.persist();
    this.refresh();
  }

  /** Automatic end state from a child. No-op when the task is no longer in_progress. */
  settle(id: string | undefined, status: TaskStatus): void {
    if (!id) return;
    if (!this.store.settle(id, status)) return;
    this.persist();
    this.refresh();
  }

  /** Run one `task` tool call. Tool results carry the snapshot, so no custom entry. */
  run(params: TaskToolParams): TaskToolResult {
    const done = (text: string, extra: { taskId?: string } = {}): TaskToolResult => {
      this.refresh();
      return { content: [{ type: "text", text }], details: { action: params.action, ...extra, ...this.store.snapshot() } };
    };
    try {
      switch (params.action) {
        case "create": {
          const task = this.store.create(params);
          return done(`Created #${task.id}: ${task.subject}`, { taskId: task.id });
        }
        case "update": {
          const task = this.store.update(params);
          return done(`Updated ${formatTaskLine(task, this.store.isReady(task))}`, { taskId: task.id });
        }
        case "get": {
          const task = this.store.get(params.id ?? "");
          if (!task) throw new Error(`Unknown task id "${normId(params.id)}".`);
          const body = [formatTaskLine(task, this.store.isReady(task))];
          if (task.description) body.push(task.description);
          if (task.activeForm) body.push(`activeForm: ${task.activeForm}`);
          return done(body.join("\n"), { taskId: task.id });
        }
        case "list":
          return done(formatTaskList(this.store));
        default:
          throw new Error(`Unknown action "${String((params as any).action)}". Use create, update, get or list.`);
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        details: { action: params.action, error: message, ...this.store.snapshot() },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// guidelines and reminder
// ---------------------------------------------------------------------------

export const TASK_REMINDER_TURNS = 10;
export const TASK_REMINDER_ENTRY = "task-reminder";

/** Flat bullets in the system prompt. No tool prefix is added, so each names `task`. */
export const TASK_PROMPT_GUIDELINES: string[] = [
  "Use `task` for work with 3+ distinct steps or when the user gives a list, including steps you do yourself. Create the tasks before you start.",
  "With `task`: set a task in_progress before you start it and completed right after it is done. Keep one in_progress at a time, unless subagents run tasks in parallel.",
  "Do not set a `task` completed when tests fail or the work is partial.",
  "Skip `task` for one-step requests and conversation.",
  "`subagent({taskId})` updates the task status by itself.",
];

export function isTaskReminderDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_TASK_REMINDER?.trim().toLowerCase() === "off";
}

function hasTaskToolCall(entry: any): boolean {
  if (entry?.type !== "message" || entry.message?.role !== "assistant") return false;
  const content = entry.message.content;
  return Array.isArray(content) && content.some((c: any) => c?.type === "toolCall" && c.name === TASK_TOOL_NAME);
}

/** True when no `task` call and no reminder happened in the last `turns` assistant messages. */
export function shouldRemindAboutTasks(entries: readonly any[], turns = TASK_REMINDER_TURNS): boolean {
  let sinceTask: number | null = null;
  let sinceReminder: number | null = null;
  let assistants = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (sinceReminder === null && entry?.type === "custom_message" && entry.customType === TASK_REMINDER_ENTRY) {
      sinceReminder = assistants;
    }
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      if (sinceTask === null && hasTaskToolCall(entry)) sinceTask = assistants;
      assistants++;
    }
    if (sinceTask !== null && sinceReminder !== null) break;
  }
  return (sinceTask ?? assistants) >= turns && (sinceReminder ?? assistants) >= turns;
}

export function formatTaskReminder(store: TaskStore): string {
  const text =
    "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using `task` (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.";
  const tasks = store.all();
  if (tasks.length === 0) return text;
  return `${text}\n\nCurrent tasks:\n${tasks.map((t) => `#${t.id}. [${t.status}] ${t.subject}`).join("\n")}`;
}
