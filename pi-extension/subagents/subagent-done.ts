/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { writeRexLabels } from "./rex-labels.ts";
import { createActivityLabelWriter, createInboxConsumer, formatToolActivity } from "./steer.ts";

const INBOX_POLL_INTERVAL_MS = 1000;

/** Run `hc label <terminal> pi.activity=<text>` without blocking the event loop. */
function runActivityLabel(terminalId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile("hc", ["label", terminalId, `pi.activity=${text}`], { timeout: 5000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Rex child: write `pi.activity` to the Rex label store for the block. */
function runRexActivityLabel(blockId: string, text: string): Promise<void> {
  try {
    writeRexLabels(blockId, { "pi.activity": text });
  } catch {}
  return Promise.resolve();
}

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

/**
 * The `.exit` sidecar of an auto-exit child whose turn ended without
 * subagent_done or caller_ping. An error turn (auto-retry exhausted, provider
 * overload, etc.) gives `type: "error"`, so the parent reports a clear failure
 * and does not mistake a stale assistant message for a result. Any other end
 * is the child's normal completion: `type: "done"`, with the text of the last
 * assistant message that has text as the summary. Without text there is no
 * summary and the parent reads the session file.
 */
export function autoExitSidecar(
  messages: any[] | undefined,
): { type: "error"; errorMessage: string; stopReason: "error" } | { type: "done"; summary?: string } {
  const errorInfo = findLatestAssistantError(messages);
  if (errorInfo) return { type: "error", ...errorInfo };
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const msg = messages![i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const texts = msg.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
      .map((block: any) => block.text as string);
    if (texts.length > 0) return { type: "done", summary: texts.join("\n") };
  }
  return { type: "done" };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  /** subagent_done or caller_ping wrote the .exit sidecar: the auto-exit path must not replace it. */
  let resultWritten = false;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  const terminalId = process.env.HC_TERMINAL_ID?.trim();
  // A Rex child has no HC_TERMINAL_ID but has REX_BLOCK.
  const rexBlock = terminalId ? undefined : process.env.REX_BLOCK?.trim();
  const activityLabel = terminalId
    ? createActivityLabelWriter({ run: (text) => runActivityLabel(terminalId, text) })
    : rexBlock
      ? createActivityLabelWriter({ run: (text) => runRexActivityLabel(rexBlock, text) })
      : null;
  const inboxFile = process.env.PI_SUBAGENT_INBOX_FILE?.trim();
  let inboxTimer: ReturnType<typeof setInterval> | null = null;

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    activityLabel?.set("starting");
    if (inboxFile && !inboxTimer) {
      const inbox = createInboxConsumer({
        inboxFile,
        deliver: (message) => pi.sendUserMessage(message.text, { deliverAs: "steer" }),
        onDelivered: (message) => recorder.inboxDelivered(message.id),
      });
      inboxTimer = setInterval(() => inbox.poll(), INBOX_POLL_INTERVAL_MS);
      inboxTimer.unref?.();
    }
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
    activityLabel?.set("thinking");
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);
    if (shouldExit) activityLabel?.set("done");
    else activityLabel?.set("waiting");

    if (shouldExit) {
      // Tell the parent how the turn ended, via the .exit sidecar (autoExitSidecar).
      // Without it the parent sees only the terminal end with exit code 0: it cannot
      // tell a clean end from a crash, and it marks the child's task as failed.
      // Not when subagent_done or caller_ping wrote theirs in this turn: that one is the result.
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile && !resultWritten) {
        try {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify(autoExitSidecar(messages)));
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the last message or the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
    activityLabel?.set(formatToolActivity((event as any).toolName, (event as any).args));
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
    activityLabel?.set("thinking");
  });

  pi.on("session_shutdown", (event) => {
    if (inboxTimer) clearInterval(inboxTimer);
    inboxTimer = null;
    activityLabel?.flush();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Ask the parent for help and exit this session; the parent can resume it with a reply.",
    parameters: Type.Object({
      message: Type.String({ description: "Your question" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));
      resultWritten = true;

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Finish and close this session. Pass your complete final report as `summary`; it is returned to the caller.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description: "Your full final report for the caller. If omitted, your last assistant message is used.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", ...(params.summary?.trim() ? { summary: params.summary } : {}) }));
        resultWritten = true;
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
