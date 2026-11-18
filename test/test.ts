import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
  __setHcExec,
  __resetHcState,
  createSurface,
  sendEscape,
  readScreen,
  closeSurface,
  sendCommand,
  getMuxBackend,
  setLayoutMode,
  parseLayoutSettings,
  getSplitRatio,
  DEFAULT_SPLIT_RATIO,
  __setHcSettings,
  applyProviderMap,
  resolveEffectiveModel,
} from "../pi-extension/subagents/hc.ts";
import { resolveChildExtensions, parseExtensionsField } from "../pi-extension/subagents/child-extensions.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  appendInboxMessage,
  createActivityLabelWriter,
  createInboxConsumer,
  formatToolActivity,
} from "../pi-extension/subagents/steer.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
} from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/hc.ts";
import {
  shouldRemindAboutTasks,
  renderTaskWidgetLines,
  renderTaskWidgetBox,
  renderTaskWidgetCollapsed,
  TASK_BOX_MIN_WIDTH,
  TaskStore,
} from "../pi-extension/subagents/tasks.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const emitted: Array<{ ch: string; d: any; sentBefore: number }> = [];
  return {
    emitted,
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      events: {
        emit(ch: string, d: any) {
          emitted.push({ ch, d, sentBefore: sentUserMessages.length });
        },
        on() {
          return () => {};
        },
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive: plain call is autonomous, fork is interactive", () => {
    const P = { name: "A", task: "T" };
    assert.equal(testApi.resolveEffectiveInteractive(P, null), false);
    assert.equal(testApi.resolveEffectiveInteractive(P, {}), false);
    assert.equal(testApi.resolveEffectiveInteractive(P, { autoExit: true }), false);
    assert.equal(testApi.resolveEffectiveInteractive({ ...P, fork: true }, null), true);
    // Agent with explicit auto-exit: false stays interactive.
    assert.equal(testApi.resolveEffectiveInteractive(P, { autoExit: false }), true);
    // Explicit param beats fork.
    assert.equal(testApi.resolveEffectiveInteractive({ ...P, fork: true, interactive: false }, null), false);
    assert.equal(testApi.resolveEffectiveInteractive({ ...P, interactive: true }, null), true);
  });

  it("resolveEffectiveAutoExit: plain call auto-exits, interactive/explicit settings honoured", () => {
    const P = { name: "A", task: "T" };
    const auto = (p: any, d: any) =>
      testApi.resolveEffectiveAutoExit(d, testApi.resolveEffectiveInteractive(p, d));
    assert.equal(auto(P, null), true);
    assert.equal(auto({ ...P, fork: true }, null), false);
    assert.equal(auto({ ...P, interactive: true }, null), false);
    assert.equal(auto(P, { autoExit: false }), false);
    assert.equal(auto(P, { autoExit: true, interactive: true }), true);
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled scout/worker/reviewer agents resolve as non-interactive; planner resolves as interactive", () => {
    for (const name of ["scout", "worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      );
    }

    const planner = testApi.loadAgentDefaults("planner");
    assert.ok(planner, "expected bundled planner to be discoverable");
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "planner", task: "" }, planner),
      true,
      "planner should resolve as interactive (no auto-exit)",
    );
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagent_control");
      assert.ok(tool, "expected subagent_control to be registered");

      const result = await tool.execute("id", { action: "list" });
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("list shows running subagents before agent definitions", () => {
    const testApi = (subagentsModule as any).__test__;
    const lines = testApi.formatRunningSubagents(
      [{ id: "ab12", name: "Scout", agent: "scout", startTime: 1_000, statusState: { phase: "active" } }],
      1_000 + 75_000,
    );
    assert.deepEqual(lines, ['• ab12 "Scout" (scout) — active, 1m15s']);
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagent_control");
      assert.ok(tool, "expected subagent_control to be registered");

      const result = await tool.execute("id", { action: "list" });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagent_control");
      assert.ok(tool, "expected subagent_control to be registered");

      const result = await tool.execute("id", { action: "list" });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("hc.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.equal(interpretExitSidecar({ type: "done", summary: "full report" }).summary, "full report");
    assert.equal(interpretExitSidecar({ type: "done", summary: "  " }).summary, undefined);
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });

  it("/plan emits a naming hint before sending the plan message", () => {
    const { api, registeredCommands, sentUserMessages, emitted } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const plan = registeredCommands.find((command) => command.name === "plan");
    assert.ok(plan, "expected /plan to be registered");

    plan.handler("Improve naming", { ui: { notify() {} } });

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].ch, "session-naming:hint");
    assert.equal(emitted[0].d.text, "Improve naming");
    assert.equal(emitted[0].d.tabPrefix, "🎯 ");
    assert.equal(emitted[0].sentBefore, 0, "emit must precede sendUserMessage");
    assert.equal(sentUserMessages.length, 1);
  });
});

describe("tool registration", () => {
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent control", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_control"), true);
    assert.equal(denied.has("subagent_interrupt"), false);
    assert.equal(denied.has("subagents_list"), false);
    assert.equal(denied.has("subagent_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_resume with an autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /default true/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_control and drops the old interrupt/list tools", () => {
    const { api, registeredTools, registeredCommands } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(registeredTools.some((tool) => tool.name === "subagent_control"), true);
    assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), false);
    assert.equal(registeredTools.some((tool) => tool.name === "subagents_list"), false);
    assert.equal(registeredCommands.some((command) => command.name === "steer"), true);
  });

  describe("subagent_control steer / stop", () => {
    function setup() {
      const dir = createTestDir();
      const inboxFile = join(dir, "inbox.jsonl");
      const activityFile = join(dir, "activity.json");
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      return { dir, inboxFile, activityFile, testApi, runningMap };
    }

    it("steer appends to the inbox and reports delivered once the child acks", async () => {
      const { dir, inboxFile, activityFile, testApi, runningMap } = setup();
      try {
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", inboxFile, activityFile }));
        const recorder = createSubagentActivityRecorder({ runningChildId: "a1", activityFile });
        recorder.sessionStart();
        const pending = testApi.handleSubagentSteer({ name: "Worker", message: "go left" }, { ackTimeoutMs: 3000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        recorder.inboxDelivered(1);
        const result = await pending;

        assert.equal(result.details.status, "steer_delivered");
        assert.match(result.content[0].text, /delivered/);
        assert.match(readFileSync(inboxFile, "utf8"), /"text":"go left"/);
      } finally {
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("steer reports not confirmed when the child never acks", async () => {
      const { dir, inboxFile, activityFile, testApi, runningMap } = setup();
      try {
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", inboxFile, activityFile }));
        const result = await testApi.handleSubagentSteer({ name: "Worker", message: "hi" }, { ackTimeoutMs: 300 });
        assert.equal(result.details.status, "steer_unconfirmed");
        assert.match(result.content[0].text, /not confirmed/);
      } finally {
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("steer requires a message and rejects Claude-backed children", async () => {
      const { dir, inboxFile, testApi, runningMap } = setup();
      try {
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", inboxFile }));
        runningMap.set("c1", makeRunning({ id: "c1", name: "Claude", cli: "claude" }));
        assert.match((await testApi.handleSubagentSteer({ name: "Worker" })).content[0].text, /non-empty/);
        assert.match((await testApi.handleSubagentSteer({ name: "Claude", message: "x" })).content[0].text, /unsupported/);
        assert.match(testApi.handleSubagentStop({ name: "Claude" }).content[0].text, /unsupported/);
      } finally {
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("interrupt with a message sends Escape first, then delivers", async () => {
      const { dir, inboxFile, activityFile, testApi, runningMap } = setup();
      try {
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "t9", inboxFile, activityFile }));
        const order: string[] = [];
        const result = await testApi.handleSubagentInterruptWithMessage(
          { name: "Worker", message: "new plan" },
          () => order.push("escape"),
          { ackTimeoutMs: 200, settleMs: 0 },
        );
        order.push(readFileSync(inboxFile, "utf8").includes("new plan") ? "inbox" : "no-inbox");
        assert.deepEqual(order, ["escape", "inbox"]);
        assert.equal(result.details.status, "interrupt_requested");
      } finally {
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("stop writes a done sidecar with the last assistant output", () => {
      const { dir, testApi, runningMap } = setup();
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, [
          JSON.stringify({ type: "session", id: "x" }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "partial work" }] } }),
        ].join("\n") + "\n");
        runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", sessionFile }));
        const result = testApi.handleSubagentStop({ name: "Worker" });
        assert.equal(result.details.status, "stop_requested");
        const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.equal(sidecar.type, "done");
        assert.match(sidecar.summary, /Stopped by parent/);
      } finally {
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      }));

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, (surface: string) => {
      sentSurface = surface;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        runningMap.set("a1", makeRunning({
          activityFile,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        }));

        withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        }));

        assert.equal(sentSurface, "pane-1");
        const state = runningMap.get("a1").statusState;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivityAtMs, 20_000);
        assert.equal(state.lastActivitySequence, 7);
        assert.equal(state.localOverrideSequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      }));

      assert.equal(sentSurface, "pane-1");
      assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape again for repeated interrupt requests", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });
      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });

      assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("rejects Claude-backed interrupt requests before delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let delivered = false;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ cli: "claude" }));

      const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: "a1",
        name: "Worker",
      });
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_resume/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("hc.ts shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

describe("hc.ts Herdr backend", () => {
  type Call = { file: string; args: string[] };
  const savedEnv = { id: process.env.HC_TERMINAL_ID, path: process.env.PATH };
  let calls: Call[];
  let binDir: string;
  let nextTerminal: number;
  let extraTerminals: Array<{ terminal: string; pane: string; tab: string }>;

  function topology() {
    const tabs: Record<string, any[]> = { tabParent: [{ terminal: "t1", pane: "pParent", status: "idle" }] };
    for (const t of extraTerminals) {
      (tabs[t.tab] ??= []).push({ terminal: t.terminal, pane: t.pane, status: "idle" });
    }
    return {
      spaces: [
        {
          id: "spA",
          name: "A",
          tabs: Object.entries(tabs).map(([id, terminals]) => ({ id, name: id, terminals })),
        },
      ],
    };
  }

  before(() => {
    binDir = mkdtempSync(join(tmpdir(), "hc-bin-"));
    for (const name of ["hc", "herdr-app"]) {
      writeFileSync(join(binDir, name), "#!/bin/sh\n", { mode: 0o755 });
    }
  });
  after(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls = [];
    nextTerminal = 10;
    extraTerminals = [];
    __resetHcState();
    process.env.HC_TERMINAL_ID = "t1";
    process.env.PATH = `${binDir}:${savedEnv.path}`;
    __setHcExec({
      async: async () => "",
      sync(file, args) {
        calls.push({ file, args });
        if (file === "herdr-app" && args[0] === "ls") return JSON.stringify(topology());
        if (file === "herdr-app" && args[1] === "pane.split") {
          const n = nextTerminal++;
          extraTerminals.push({ terminal: `t${n}`, pane: `p${n}`, tab: "tabParent" });
          return JSON.stringify({ pane: `p${n}`, terminal: `t${n}` });
        }
        if (file === "hc" && args[0] === "run") {
          const n = nextTerminal++;
          const tabLabel = args.find((a) => a.startsWith("herdr.tab="));
          const tab = tabLabel ? tabLabel.slice("herdr.tab=".length) : "tabNew";
          // Real ids are base-36 after `t` (e.g. `t1z`); `hc run --json` prints {address, ...}.
          const id = `t${n}z`;
          extraTerminals.push({ terminal: id, pane: `p${n}`, tab });
          return JSON.stringify({ address: id, state: "running" }) + "\n";
        }
        return "";
      },
    });
  });

  afterEach(() => {
    __setHcExec(null);
    if (savedEnv.id === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = savedEnv.id;
    process.env.PATH = savedEnv.path;
  });

  const doCalls = () => calls.filter((c) => c.file === "herdr-app" && c.args[0] === "do");

  it("detects the backend from HC_TERMINAL_ID and PATH", () => {
    assert.equal(getMuxBackend(), "herdr");
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null);
    process.env.HC_TERMINAL_ID = "t1";
    process.env.PATH = "/nonexistent";
    assert.equal(getMuxBackend(), null);
  });

  it("splits right, then down on the last child, and refocuses the focused pane right after each split", () => {
    const a = createSurface("a");
    const b = createSurface("b");
    assert.deepEqual([a, b], ["t10", "t11"]);

    const seq = doCalls().map((c) => c.args.slice(1));
    assert.deepEqual(seq[0], ["pane.split", "--direction", "right", "--pane", "pParent", "--argv", JSON.stringify(["/bin/bash", "--noprofile", "--norc"])]);
    assert.deepEqual(seq[1], ["pane.focus", "--pane", "pParent"]);
    assert.deepEqual(seq[2].slice(0, 3), ["layout.resize", "--id", "p10"]);
    assert.deepEqual(seq[3].slice(0, 3), ["layout.resize", "--id", "pParent"]);
    assert.deepEqual(seq[4].slice(0, 5), ["pane.split", "--direction", "down", "--pane", "p10"]);
    assert.deepEqual(seq[5], ["pane.focus", "--pane", "pParent"]);

    // focus call is the very next CLI call after each split
    const idx = calls.findIndex((c) => c.args[1] === "pane.split");
    assert.equal(calls[idx + 1].args[1], "pane.focus");
  });

  it("labels a child with pi.taskid and pi.tasksubject (80 chars max)", () => {
    createSurface("a", { task: "t", taskId: "4", taskSubject: `Do   the\nthing ${"x".repeat(100)}` });
    createSurface("b", { task: "t" });
    const labels = calls.filter((c) => c.file === "hc" && c.args[0] === "label");
    assert.equal(labels.length, 2);
    const withTask = labels[0].args;
    assert.ok(withTask.includes("pi.taskid=4"));
    const subject = withTask.find((a) => a.startsWith("pi.tasksubject="))!.slice("pi.tasksubject=".length);
    assert.equal(subject.length, 80);
    assert.ok(subject.startsWith("Do the thing x"));
    assert.ok(!labels[1].args.some((a) => a.startsWith("pi.taskid=") || a.startsWith("pi.tasksubject=")));
  });

  describe("focus restore", () => {
    const base = (statusImpl: () => string) => {
      __setHcExec({
        async: async () => "",
        sync(file, args) {
          calls.push({ file, args });
          if (file === "herdr-app" && args[0] === "status") return statusImpl();
          if (file === "herdr-app" && args[0] === "ls") return JSON.stringify(topology());
          if (file === "herdr-app" && args[1] === "pane.split") {
            const n = nextTerminal++;
            extraTerminals.push({ terminal: `t${n}`, pane: `p${n}`, tab: "tabParent" });
            return JSON.stringify({ pane: `p${n}`, terminal: `t${n}` });
          }
          return "";
        },
      });
    };
    const focusCalls = () => doCalls().filter((c) => c.args[1] === "pane.focus");

    it("returns focus to the user's pane in another workspace", () => {
      base(() => JSON.stringify({ space: "spOther", focused_pane: "pUser" }));
      createSurface("a");
      assert.deepEqual(focusCalls().map((c) => c.args.slice(1)), [["pane.focus", "--pane", "pUser"]]);
      const statusIdx = calls.findIndex((c) => c.args[0] === "status");
      const splitIdx = calls.findIndex((c) => c.args[1] === "pane.split");
      assert.ok(statusIdx >= 0 && statusIdx < splitIdx);
    });

    it("does not run pane.focus when focused_pane is null or missing", () => {
      base(() => JSON.stringify({ focused_pane: null }));
      createSurface("a");
      assert.equal(focusCalls().length, 0);
      base(() => JSON.stringify({ space: "x" }));
      createSurface("b");
      assert.equal(focusCalls().length, 0);
    });

    it("falls back to the parent pane when status fails or does not parse", () => {
      base(() => {
        throw new Error("boom");
      });
      createSurface("a");
      base(() => "not json");
      createSurface("b");
      assert.deepEqual(focusCalls().map((c) => c.args.slice(1)), [
        ["pane.focus", "--pane", "pParent"],
        ["pane.focus", "--pane", "pParent"],
      ]);
    });
  });

  it("overflows to the Subagents tab after maxSplitChildren live children", () => {
    for (let i = 0; i < 4; i++) createSurface(`c${i}`);
    assert.equal(doCalls().filter((c) => c.args[1] === "pane.split").length, 4);
    const fifth = createSurface("c4");
    const run = calls.find((c) => c.file === "hc" && c.args[0] === "run")!;
    assert.ok(run.args.includes("herdr.space=spA"));
    assert.ok(!run.args.some((a) => a.startsWith("herdr.tab=")));
    assert.ok(fifth.startsWith("t"));
  });

  it("tab mode: first child creates and renames the Subagents tab, later children reuse it", () => {
    setLayoutMode("tab");
    createSurface("a");
    const rename = doCalls().find((c) => c.args[1] === "tab.rename")!;
    assert.deepEqual(rename.args.slice(1), ["tab.rename", "--id", "tabNew", "--name", "Subagents"]);
    assert.equal(doCalls().some((c) => c.args[1] === "pane.split"), false);

    createSurface("b");
    const runs = calls.filter((c) => c.file === "hc" && c.args[0] === "run");
    assert.equal(runs.length, 2);
    assert.ok(runs[1].args.includes("herdr.tab=tabNew"));
    assert.equal(doCalls().filter((c) => c.args[1] === "tab.rename").length, 1);
  });

  it("sets labels on each child", () => {
    const t = createSurface("My Agent", { role: "worker", task: "line one\nline two " + "x".repeat(200) });
    const label = calls.find((c) => c.file === "hc" && c.args[0] === "label")!;
    assert.equal(label.args[1], t);
    assert.ok(label.args.includes("pi.subagent=1"));
    assert.ok(label.args.includes("pi.role=worker"));
    assert.ok(label.args.includes("pi.name=My Agent"));
    assert.ok(label.args.includes("pi.parent=t1"));
    const task = label.args.find((a) => a.startsWith("pi.task="))!;
    assert.equal(task.length, "pi.task=".length + 120);
    assert.ok(!task.includes("\n"));
    createSurface("other");
    const second = calls.filter((c) => c.file === "hc" && c.args[0] === "label")[1];
    assert.ok(second.args.includes("pi.role=none"));
  });

  it("maps interrupt, read, send and close to hc commands", () => {
    const t = createSurface("a");
    calls.length = 0;
    sendEscape(t);
    readScreen(t, 30);
    sendCommand(t, "echo hi");
    closeSurface(t);
    assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
      ["hc", "keys", t, "esc"],
      ["hc", "read", t, "--lines", "30"],
      ["hc", "send", t, "echo hi"],
      ["hc", "kill", t],
      ["hc", "rm", t],
    ]);
  });

  it("closing a split child frees its slot in the column", () => {
    const ids = [0, 1, 2, 3].map((i) => createSurface(`c${i}`));
    closeSurface(ids[3]);
    calls.length = 0;
    createSurface("again");
    assert.ok(doCalls().some((c) => c.args[1] === "pane.split" && c.args.includes("p12")));
  });

  describe("splitRatio", () => {
    const resizes = () => doCalls().filter((c) => c.args[1] === "layout.resize").map((c) => c.args.slice(1));

    it("defaults to 1/3 and sizes the child column after the first (right) split only", () => {
      assert.equal(getSplitRatio(), DEFAULT_SPLIT_RATIO);
      createSurface("a");
      createSurface("b");
      createSurface("c");
      assert.deepEqual(resizes(), [
        ["layout.resize", "--id", "p10", "--weight", String(2 / 3)],
        ["layout.resize", "--id", "pParent", "--weight", String(2 * (1 - 1 / 3))],
      ]);
      // pane.split never gets a ratio argument: herdr-app rejects unknown arguments
      const splits = doCalls().filter((c) => c.args[1] === "pane.split");
      assert.equal(splits.length, 3);
      assert.ok(splits.every((c) => !c.args.includes("--ratio")));
      // resize comes after the split and its focus restore, so focus stays the very next call
      const idx = calls.findIndex((c) => c.args[1] === "pane.split");
      assert.equal(calls[idx + 1].args[1], "pane.focus");
      assert.equal(calls[idx + 2].args[1], "layout.resize");
    });

    it("uses the configured ratio; the weights add up to 2", () => {
      __setHcSettings({ splitRatio: 0.25 });
      assert.equal(getSplitRatio(), 0.25);
      createSurface("a");
      assert.deepEqual(resizes(), [
        ["layout.resize", "--id", "p10", "--weight", "0.5"],
        ["layout.resize", "--id", "pParent", "--weight", "1.5"],
      ]);
    });

    it("does not resize in tab mode", () => {
      setLayoutMode("tab");
      createSurface("a");
      assert.deepEqual(resizes(), []);
    });

    it("keeps the spawn when layout.resize fails", () => {
      __setHcExec({
        async: async () => "",
        sync(file, args) {
          calls.push({ file, args });
          if (file === "herdr-app" && args[0] === "ls") return JSON.stringify(topology());
          if (file === "herdr-app" && args[1] === "layout.resize") throw new Error("boom");
          if (file === "herdr-app" && args[1] === "pane.split") {
            const n = nextTerminal++;
            extraTerminals.push({ terminal: `t${n}`, pane: `p${n}`, tab: "tabParent" });
            return JSON.stringify({ pane: `p${n}`, terminal: `t${n}` });
          }
          return "";
        },
      });
      assert.equal(createSurface("a"), "t10");
    });

    it("accepts 0.1..0.9 and ignores anything else", () => {
      assert.deepEqual(parseLayoutSettings({ splitRatio: 0.5 }), { splitRatio: 0.5 });
      assert.deepEqual(parseLayoutSettings({ splitRatio: 0.1 }), { splitRatio: 0.1 });
      assert.deepEqual(parseLayoutSettings({ splitRatio: 0.9 }), { splitRatio: 0.9 });
      for (const bad of [0.05, 0.95, 0, 1, -0.3, NaN, Infinity, "0.5", null, [0.5]]) {
        assert.deepEqual(parseLayoutSettings({ splitRatio: bad }), {}, `splitRatio ${String(bad)}`);
      }
    });

    it("an invalid setting falls back to the default", () => {
      __setHcSettings(parseLayoutSettings({ splitRatio: 5 }));
      assert.equal(getSplitRatio(), DEFAULT_SPLIT_RATIO);
    });
  });

  it("parses layout settings", () => {
    assert.deepEqual(parseLayoutSettings({ layout: "tab", maxSplitChildren: 2 }), { layout: "tab", maxSplitChildren: 2 });
    assert.deepEqual(parseLayoutSettings({ layout: "bogus", maxSplitChildren: -1 }), {});
    assert.deepEqual(parseLayoutSettings(undefined), {});
  });
});


describe("lean child extensions", () => {
  const { buildChildExtensionArgs, runningSubagents, loadAgentDefaults } = (subagentsModule as any).__test__;
  const selfIndex = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
  const doneTs = fileURLToPath(new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url));
  let dir: string;
  let calls: { file: string; args: string[] }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lean-"));
    calls = [];
    __resetHcState();
    __setHcExec({
      sync: (file, args) => {
        calls.push({ file, args });
        return "";
      },
      async: async () => "",
    });
  });
  afterEach(() => {
    __setHcExec(null);
    __resetHcState();
    rmSync(dir, { recursive: true, force: true });
  });

  const q = (p: string) => `'${p}'`;

  it("inherit mode: only subagent-done", () => {
    __setHcSettings({});
    assert.deepEqual(buildChildExtensionArgs(["/x/ignored.ts"]), ["-e", q(doneTs)]);
  });

  it("lean mode order: -ne, allowlist, frontmatter extras, subagent-done", () => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "");
    writeFileSync(b, "");
    __setHcSettings({ childExtensions: [a] });
    assert.deepEqual(buildChildExtensionArgs([b]), ["-ne", "-e", q(a), "-e", q(b), "-e", q(doneTs)]);
  });

  it("empty array still means lean", () => {
    __setHcSettings({ childExtensions: [] });
    assert.deepEqual(buildChildExtensionArgs(), ["-ne", "-e", q(doneTs)]);
  });

  it("expands package dirs via pi.extensions", () => {
    const pkg = join(dir, "pkg");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "src", "x.ts"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./src/x.ts", "./gone.ts"] } }));
    const warns: string[] = [];
    const out = resolveChildExtensions([pkg], { selfPath: selfIndex, warn: (m) => warns.push(m) });
    assert.deepEqual(out, [join(pkg, "src", "x.ts")]);
    assert.equal(warns.length, 1);
  });

  it("skips and warns on missing paths", () => {
    const warns: string[] = [];
    const out = resolveChildExtensions([join(dir, "nope.ts")], { selfPath: selfIndex, warn: (m) => warns.push(m) });
    assert.deepEqual(out, []);
    assert.equal(warns.length, 1);
  });

  it("never loads the fork's own index.ts (direct or via package dir)", () => {
    const pkg = join(dir, "self");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: [selfIndex] } }));
    const out = resolveChildExtensions([selfIndex, pkg], { selfPath: selfIndex, warn: () => {} });
    assert.deepEqual(out, []);
  });

  it("parses frontmatter extensions as list forms", () => {
    assert.deepEqual(parseExtensionsField("name: x\nextensions: ~/a.ts, /b.ts"), ["~/a.ts", "/b.ts"]);
    assert.deepEqual(parseExtensionsField("extensions: [\"/a.ts\", /b.ts]"), ["/a.ts", "/b.ts"]);
    assert.deepEqual(parseExtensionsField("extensions:\n  - /a.ts\n  - /b.ts\nmodel: m"), ["/a.ts", "/b.ts"]);
    assert.equal(parseExtensionsField("name: x"), undefined);
  });

  it("closeSurface runs kill then rm and ignores rm errors", () => {
    __setHcExec({
      sync: (file, args) => {
        calls.push({ file, args });
        if (args[0] === "rm") throw new Error("no such terminal");
        return "";
      },
      async: async () => "",
    });
    closeSurface("t9");
    assert.deepEqual(calls.map((c) => c.args), [["kill", "t9"], ["rm", "t9"]]);
  });

  it("session_shutdown closes running children", () => {
    const handlers: Record<string, Function> = {};
    const fakePi: any = { on: (n: string, h: Function) => (handlers[n] = h), registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {} };
    try {
      (subagentsModule as any).default(fakePi);
    } catch {}
    assert.ok(handlers.session_shutdown);
    runningSubagents.set("zz", { id: "zz", surface: "t77", name: "n" } as any);
    handlers.session_shutdown({ reason: "quit" }, {});
    assert.ok(calls.some((c) => c.args[0] === "kill" && c.args[1] === "t77"));
    assert.ok(calls.some((c) => c.args[0] === "rm" && c.args[1] === "t77"));
    assert.equal(runningSubagents.size, 0);
  });

  it("session_shutdown keeps children running on reload", () => {
    const handlers: Record<string, Function> = {};
    const fakePi: any = { on: (n: string, h: Function) => (handlers[n] = h), registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {} };
    try {
      (subagentsModule as any).default(fakePi);
    } catch {}
    runningSubagents.set("zy", { id: "zy", surface: "t78", name: "n" } as any);
    handlers.session_shutdown({ reason: "reload" }, {});
    assert.ok(!calls.some((c) => c.args[0] === "kill" && c.args[1] === "t78"));
    assert.equal(runningSubagents.size, 0);
  });

  it("session_shutdown stops old pollers but new spawns can still be watched", () => {
    // /new keeps the loaded module: the next session's watchers use the same module abort signal.
    const handlers: Record<string, Function> = {};
    const fakePi: any = { on: (n: string, h: Function) => (handlers[n] = h), registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {} };
    try {
      (subagentsModule as any).default(fakePi);
    } catch {}
    const before = (subagentsModule as any).__test__.getModuleAbortSignal() as AbortSignal;
    assert.equal(before.aborted, false);
    handlers.session_shutdown({ reason: "new" }, {});
    assert.equal(before.aborted, true);
    const after = (subagentsModule as any).__test__.getModuleAbortSignal() as AbortSignal;
    assert.equal(after.aborted, false);
  });
});

describe("model resolution settings", () => {
  it("parses defaultModel and providerMap", () => {
    assert.deepEqual(
      parseLayoutSettings({ defaultModel: "claude-bridge/claude-haiku-5-5", providerMap: { anthropic: "claude-bridge" } }),
      { defaultModel: "claude-bridge/claude-haiku-5-5", providerMap: { anthropic: "claude-bridge" } },
    );
    assert.deepEqual(parseLayoutSettings({ defaultModel: "  ", providerMap: ["x"] }), {});
    assert.deepEqual(parseLayoutSettings({ providerMap: { anthropic: 1, "": "x", ok: "y" } }), { providerMap: { ok: "y" } });
  });

  it("precedence: param > agent > defaultModel", () => {
    const settings = { defaultModel: "openai/gpt-x" };
    assert.equal(resolveEffectiveModel("param/a", "agent/b", settings), "param/a");
    assert.equal(resolveEffectiveModel(undefined, "agent/b", settings), "agent/b");
    assert.equal(resolveEffectiveModel(undefined, undefined, settings), "openai/gpt-x");
  });

  it("providerMap rewrites the provider prefix of the final model, keeping :thinking", () => {
    const settings = { providerMap: { anthropic: "claude-bridge" } };
    assert.equal(resolveEffectiveModel(undefined, "anthropic/claude-opus-4-6", settings), "claude-bridge/claude-opus-4-6");
    assert.equal(resolveEffectiveModel("anthropic/claude-sonnet-4-6:high", undefined, settings), "claude-bridge/claude-sonnet-4-6:high");
    assert.equal(resolveEffectiveModel(undefined, undefined, { defaultModel: "anthropic/claude-haiku-4-5", providerMap: { anthropic: "claude-bridge" } }), "claude-bridge/claude-haiku-4-5");
  });

  it("unmapped provider is untouched", () => {
    const settings = { providerMap: { anthropic: "claude-bridge" } };
    assert.equal(resolveEffectiveModel("openai/gpt-x", undefined, settings), "openai/gpt-x");
    assert.equal(applyProviderMap("openai/gpt-x", { anthropic: "claude-bridge" }), "openai/gpt-x");
    assert.equal(applyProviderMap("no-slash", { anthropic: "claude-bridge" }), "no-slash");
  });

  it("no settings keeps old behaviour", () => {
    assert.equal(resolveEffectiveModel(undefined, undefined, {}), undefined);
    assert.equal(resolveEffectiveModel("anthropic/claude-opus-4-6", undefined, {}), "anthropic/claude-opus-4-6");
    assert.equal(resolveEffectiveModel(undefined, "anthropic/claude-haiku-4-5", {}), "anthropic/claude-haiku-4-5");
  });
});

describe("steer.ts", () => {
  describe("formatToolActivity", () => {
    it("formats bash, file tools and unknown tools on one line", () => {
      assert.equal(formatToolActivity("bash", { command: "npm test" }), "bash: npm test");
      assert.equal(formatToolActivity("read", { path: "/a/b/hc.ts" }), "read: hc.ts");
      assert.equal(formatToolActivity("subagent_done", {}), "subagent_done");
      assert.equal(formatToolActivity(undefined, undefined), "tool");
      assert.equal(formatToolActivity("bash", { command: "echo a\n  b" }), "bash: echo a b");
    });

    it("truncates to 80 characters", () => {
      const text = formatToolActivity("bash", { command: "x".repeat(300) });
      assert.equal(text.length, 80);
      assert.ok(text.endsWith("…"));
    });
  });

  describe("createActivityLabelWriter", () => {
    function makeWriter() {
      let now = 10_000;
      const writes: string[] = [];
      const writer = createActivityLabelWriter({ run: (text) => { writes.push(text); }, now: () => now });
      return { writer, writes, advance: (ms: number) => { now += ms; } };
    }

    it("writes the first value at once and skips unchanged text", () => {
      const { writer, writes, advance } = makeWriter();
      writer.set("thinking");
      advance(5000);
      writer.set("thinking");
      assert.deepEqual(writes, ["thinking"]);
    });

    it("writes at most once per 2 s; the latest pending value goes out on flush", () => {
      const { writer, writes, advance } = makeWriter();
      writer.set("thinking");
      advance(500);
      writer.set("bash: a");
      writer.set("bash: b");
      assert.deepEqual(writes, ["thinking"]);
      advance(1600);
      writer.set("read: c");
      assert.deepEqual(writes, ["thinking", "read: c"]);
    });

    it("flush sends the pending value and a throwing run never escapes", () => {
      let now = 0;
      const writer = createActivityLabelWriter({
        run: () => { throw new Error("hc missing"); },
        now: () => now,
      });
      assert.doesNotThrow(() => writer.set("a"));
      now += 100;
      writer.set("b");
      assert.doesNotThrow(() => writer.flush());
    });

    it("collapses whitespace and ignores empty text", () => {
      const { writer, writes } = makeWriter();
      writer.set("   ");
      writer.set("a\n  b");
      assert.deepEqual(writes, ["a b"]);
    });
  });

  describe("inbox", () => {
    it("delivers each message once, in order, and acks", () => {
      const dir = createTestDir();
      try {
        const file = join(dir, "sub", "inbox.jsonl");
        const delivered: string[] = [];
        const acked: number[] = [];
        const consumer = createInboxConsumer({
          inboxFile: file,
          deliver: (m) => delivered.push(m.text),
          onDelivered: (m) => acked.push(m.id),
        });
        consumer.poll(); // missing file is fine
        assert.equal(appendInboxMessage(file, "one"), 1);
        assert.equal(appendInboxMessage(file, "two\nlines"), 2);
        consumer.poll();
        consumer.poll();
        assert.equal(appendInboxMessage(file, "three"), 3);
        consumer.poll();
        assert.deepEqual(delivered, ["one", "two\nlines", "three"]);
        assert.deepEqual(acked, [1, 2, 3]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("waits for a complete line and survives a failing deliver", () => {
      const dir = createTestDir();
      try {
        const file = join(dir, "inbox.jsonl");
        const delivered: number[] = [];
        let fail = true;
        const consumer = createInboxConsumer({
          inboxFile: file,
          deliver: (m) => {
            if (fail && m.id === 1) throw new Error("boom");
            delivered.push(m.id);
          },
        });
        writeFileSync(file, '{"id":1,"text":"a","at":0}\n{"id":2,"te');
        assert.doesNotThrow(() => consumer.poll());
        fail = false;
        writeFileSync(file, '{"id":1,"text":"a","at":0}\n{"id":2,"text":"b","at":0}\n');
        consumer.poll();
        assert.deepEqual(delivered, [2]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("recorder stores inboxAck in the activity snapshot", () => {
    const dir = createTestDir();
    try {
      const activityFile = join(dir, "a.json");
      const recorder = createSubagentActivityRecorder({ runningChildId: "k1", activityFile });
      recorder.sessionStart();
      recorder.inboxDelivered(4);
      const read = readSubagentActivityFile(activityFile, "k1");
      assert.ok(read.ok);
      assert.equal((read as any).activity.inboxAck, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("task tool", () => {
  const savedEnv = {
    id: process.env.PI_SUBAGENT_ID,
    term: process.env.HC_TERMINAL_ID,
    deny: process.env.PI_DENY_TOOLS,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  let calls: { file: string; args: string[] }[];
  /** Agent dir for this test: subagents-ui.json goes here, never to the real ~/.pi/agent. */
  let agentDir: string;

  beforeEach(() => {
    calls = [];
    agentDir = mkdtempSync(join(tmpdir(), "task-ui-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_DENY_TOOLS;
    process.env.HC_TERMINAL_ID = "t1";
    __resetHcState();
    __setHcExec({
      sync: (file, args) => {
        calls.push({ file, args });
        return "";
      },
      async: async () => "",
    });
  });
  afterEach(() => {
    __setHcExec(null);
    restoreEnvVar("PI_SUBAGENT_ID", savedEnv.id);
    restoreEnvVar("HC_TERMINAL_ID", savedEnv.term);
    restoreEnvVar("PI_DENY_TOOLS", savedEnv.deny);
    restoreEnvVar("PI_CODING_AGENT_DIR", savedEnv.agentDir);
    rmSync(agentDir, { recursive: true, force: true });
  });

  const labelCalls = () => calls.filter((c) => c.file === "hc" && c.args[0] === "label");
  const lastLabel = () => labelCalls().at(-1)?.args.slice(2);

  /** Row texts of a plain-text task box: strip `│ ` and ` │`, trim padding. */
  const boxRows = (lines: string[]) => lines.slice(1, -1).map((l) => l.replace(/^│ /, "").replace(/ *│$/, ""));

  /** Load the extension with a fake Pi that records handlers, tools and custom entries. */
  function setup(branch: any[] = []) {
    const handlers: Record<string, Function> = {};
    const tools: any[] = [];
    const commands: Record<string, any> = {};
    const entries: Array<{ type: string; data: any }> = [];
    const widgets: Array<string[] | undefined> = [];
    /** Every setWidget call in order: key and the factory (undefined clears). */
    const mounts: Array<{ key: string; factory: any }> = [];
    const notes: string[] = [];
    const shortcuts: Record<string, any> = {};
    const busHandlers: Record<string, Function> = {};
    const unsubscribed: string[] = [];
    const active = { list: ["task"] };
    const pi: any = {
      getActiveTools: () => active.list,
      on: (n: string, h: Function) => (handlers[n] = h),
      registerTool: (t: any) => tools.push(t),
      registerCommand: (n: string, c: any) => (commands[n] = c),
      registerMessageRenderer() {},
      registerShortcut: (k: string, o: any) => (shortcuts[k] = o),
      appendEntry: (type: string, data: any) => entries.push({ type, data }),
      events: {
        emit() {},
        on: (ch: string, h: Function) => {
          busHandlers[ch] = h;
          return () => {
            delete busHandlers[ch];
            unsubscribed.push(ch);
          };
        },
      },
    };
    const state = { branch };
    const ctx: any = {
      hasUI: true,
      ui: {
        setWidget: (k: string, c: any) => {
          mounts.push({ key: k, factory: c });
          if (k !== "tasks") return;
          widgets.push(
            typeof c === "function"
              ? c({}, plainTheme)
                  .render(80)
                  .map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")) // plain text; colours are tested on renderTaskWidgetBox
              : c,
          );
        },
        notify: (m: string) => notes.push(m),
      },
      sessionManager: { getBranch: () => state.branch },
    };
    (subagentsModule as any).default(pi);
    const tool = tools.find((t) => t.name === "task");
    const run = (params: any) => tool.execute("id", params, undefined, undefined, ctx);
    return { handlers, tools, commands, entries, widgets, mounts, notes, shortcuts, busHandlers, unsubscribed, ctx, state, tool, run, pi, active };
  }
  const plainTheme = { strikethrough: (t: string) => `~${t}~`, fg: (_n: string, t: string) => t };

  describe("store rules", () => {
    it("creates, updates and gets tasks with string integer ids", async () => {
      const { run } = setup();
      const a = await run({ action: "create", subject: "  Write   code ", description: "details" });
      assert.equal(a.details.taskId, "1");
      assert.match(a.content[0].text, /Created #1: Write code/);
      await run({ action: "create", subject: "Review" });
      const upd = await run({ action: "update", id: "2", subject: "Review it", activeForm: "Reviewing", owner: "me" });
      assert.match(upd.content[0].text, /#2 \[pending\]/);
      const got = await run({ action: "get", id: "2" });
      assert.match(got.content[0].text, /Review it/);
      assert.match(got.content[0].text, /activeForm: Reviewing/);
      assert.deepEqual(
        got.details.tasks.map((t: any) => [t.id, t.status]),
        [["1", "pending"], ["2", "pending"]],
      );
      assert.equal(got.details.nextId, 3);
    });

    it("list marks a task ready only when pending and all blockers are completed", async () => {
      const { run } = setup();
      await run({ action: "create", subject: "A" });
      await run({ action: "create", subject: "B", blockedBy: ["1"] });
      let list = await run({ action: "list" });
      const lines = () => list.content[0].text.split("\n");
      assert.match(lines()[0], /^#1 \[pending\] ready A/);
      assert.doesNotMatch(lines()[1], /ready/);
      await run({ action: "update", id: "1", status: "in_progress" });
      list = await run({ action: "list" });
      assert.doesNotMatch(lines()[0], /ready/);
      assert.doesNotMatch(lines()[1], /ready/);
      await run({ action: "update", id: "1", status: "completed" });
      list = await run({ action: "list" });
      assert.match(lines()[1], /^#2 \[pending\] ready B/);
      await run({ action: "update", id: "1", status: "failed" });
      list = await run({ action: "list" });
      assert.doesNotMatch(lines()[1], /ready/);
    });

    it("rejects unknown ids, unknown blockers, bad status and cycles", async () => {
      const { run } = setup();
      await run({ action: "create", subject: "A" });
      await run({ action: "create", subject: "B", blockedBy: ["1"] });
      await run({ action: "create", subject: "C", blockedBy: ["2"] });

      assert.match((await run({ action: "get", id: "9" })).details.error, /Unknown task id "9"/);
      assert.match((await run({ action: "update", id: "9", status: "completed" })).details.error, /Unknown task id/);
      assert.match((await run({ action: "create", subject: "D", blockedBy: ["7"] })).details.error, /Unknown blocker "7"/);
      assert.match((await run({ action: "update", id: "1", addBlockedBy: ["8"] })).details.error, /Unknown blocker/);
      assert.match((await run({ action: "update", id: "1", status: "done" })).details.error, /Unknown status/);
      assert.match((await run({ action: "create" })).details.error, /subject is required/);
      // cycles: direct, transitive, self
      assert.match((await run({ action: "update", id: "1", addBlockedBy: ["2"] })).details.error, /cycle/);
      assert.match((await run({ action: "update", id: "1", addBlockedBy: ["3"] })).details.error, /cycle/);
      assert.match((await run({ action: "update", id: "1", addBlockedBy: ["1"] })).details.error, /cycle/);
      // a rejected update changes nothing
      const list = await run({ action: "list" });
      assert.deepEqual(list.details.tasks[0].blockedBy, []);
      assert.equal(list.details.tasks.length, 3);
      // removeBlockedBy works and then the edge is allowed
      await run({ action: "update", id: "2", removeBlockedBy: ["1"] });
      assert.equal((await run({ action: "update", id: "1", addBlockedBy: ["2"] })).details.error, undefined);
    });
  });

  describe("registration", () => {
    it("registers task and /tasks in the parent, next to subagent", () => {
      const { tools, commands } = setup();
      assert.ok(tools.some((t) => t.name === "subagent"));
      assert.ok(tools.some((t) => t.name === "task"));
      assert.ok(commands.tasks);
    });

    it("does not register task in a child (PI_SUBAGENT_ID set)", () => {
      process.env.PI_SUBAGENT_ID = "abc12345";
      const { tools, commands } = setup();
      assert.equal(tools.some((t) => t.name === "task"), false);
      assert.equal(commands.tasks, undefined);
      assert.equal((subagentsModule as any).__test__.getTaskController(), null);
    });

    it("does not register task where subagent is denied", () => {
      process.env.PI_DENY_TOOLS = "subagent";
      const { tools } = setup();
      assert.equal(tools.some((t) => t.name === "task"), false);
    });

    it("keeps the task tool definition small (350 tokens, about 1400 chars)", () => {
      const { tool } = setup();
      const size = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
      assert.ok(size <= 1400, `task definition is ${size} chars`);
      assert.match(JSON.stringify(setup().tools.find((t) => t.name === "subagent").parameters), /taskId/);
    });
  });

  describe("spawn with taskId", () => {
    it("rejects an unknown task id and a task that is not pending, before any launch", async () => {
      const { tools, run } = setup();
      const subagent = tools.find((t) => t.name === "subagent");
      const spawn = (taskId: string) =>
        subagent.execute("id", { name: "W", task: "do", taskId }, undefined, undefined, {
          sessionManager: { getSessionFile: () => "/nonexistent/s.jsonl" },
        });
      const unknown = await spawn("5");
      assert.match(unknown.content[0].text, /Unknown task id "5"/);

      await run({ action: "create", subject: "A" });
      await run({ action: "update", id: "1", status: "in_progress" });
      const busy = await spawn("1");
      assert.match(busy.content[0].text, /Task #1 is in_progress, not pending/);
      await run({ action: "update", id: "1", status: "completed" });
      assert.match((await spawn("#1")).content[0].text, /is completed, not pending/);
      assert.equal(labelCalls().some((c) => c.args.includes("pi.taskid=1")), false);
    });

    it("claim sets in_progress and the owner, and refuses a second claim", () => {
      setup();
      const controller = (subagentsModule as any).__test__.getTaskController();
      controller.run({ action: "create", subject: "A" });
      const task = controller.claim("1", "Worker");
      assert.equal(task.status, "in_progress");
      assert.equal(task.owner, "Worker");
      assert.throws(() => controller.claim("1", "Other"), /in_progress, not pending/);
      assert.throws(() => controller.claim("4", "Other"), /Unknown task id/);
      controller.release("1");
      assert.equal(controller.store.get("1").status, "pending");
      assert.equal(controller.store.get("1").owner, undefined);
    });
  });

  describe("automatic changes", () => {
    const api = () => (subagentsModule as any).__test__;
    const running = (over: Record<string, unknown> = {}) => ({ id: "ab12", name: "Worker", taskId: "1", ...over });
    const result = (over: Record<string, unknown> = {}) => ({ name: "Worker", task: "", summary: "ok", exitCode: 0, elapsed: 1, ...over });

    function started() {
      const ctxs = setup();
      const controller = api().getTaskController();
      controller.run({ action: "create", subject: "A" });
      controller.claim("1", "Worker (ab12)");
      return { ...ctxs, controller };
    }
    const statusOf = (c: any) => c.store.get("1").status;

    it("a child result completes the task", () => {
      const { controller } = started();
      api().settleTaskForResult(running(), result());
      assert.equal(statusOf(controller), "completed");
    });

    it("an error, a non-zero exit or no result fails the task", () => {
      for (const over of [{ errorMessage: "boom" }, { exitCode: 2 }, { noResult: true }, { error: "x" }]) {
        const { controller } = started();
        api().settleTaskForResult(running(), result(over));
        assert.equal(statusOf(controller), "failed", JSON.stringify(over));
      }
    });

    it("a stopped child cancels the task", () => {
      const { controller } = started();
      api().settleTaskForResult(running({ stopped: true }), result());
      assert.equal(statusOf(controller), "cancelled");
    });

    it("subagent_control stop marks the child stopped; the following result cancels", () => {
      const { controller } = started();
      const dir = createTestDir();
      try {
        const map = api().runningSubagents as Map<string, any>;
        map.clear();
        const child: any = {
          id: "ab12",
          name: "Worker",
          task: "",
          taskId: "1",
          surface: "t9",
          startTime: 0,
          sessionFile: join(dir, "w.jsonl"),
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        };
        map.set("ab12", child);
        const out = api().handleSubagentStop({ name: "Worker" });
        assert.equal(out.details.status, "stop_requested");
        assert.equal(child.stopped, true);
        api().settleTaskForResult(child, result());
        assert.equal(statusOf(controller), "cancelled");
        map.clear();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a ping or a parent-session cancel leaves the task in progress; a manual change is not overwritten", () => {
      const { controller } = started();
      api().settleTaskForResult(running(), result({ ping: { name: "W", message: "help" } }));
      api().settleTaskForResult(running(), result({ error: "cancelled", exitCode: 1 }));
      assert.equal(statusOf(controller), "in_progress");
      controller.run({ action: "update", id: "1", status: "cancelled" });
      api().settleTaskForResult(running(), result());
      assert.equal(statusOf(controller), "cancelled");
    });

    it("a child without taskId touches nothing", () => {
      const { controller, entries } = started();
      const before = entries.length;
      api().settleTaskForResult({ id: "x", name: "N" }, result());
      assert.equal(statusOf(controller), "in_progress");
      assert.equal(entries.length, before);
    });

    it("automatic changes are stored as task-snapshot custom entries", () => {
      const { entries, controller } = started();
      assert.equal(entries.at(-1)!.type, "task-snapshot");
      api().settleTaskForResult(running(), result());
      const last = entries.at(-1)!;
      assert.equal(last.type, "task-snapshot");
      assert.equal(last.data.tasks[0].status, "completed");
      assert.equal(last.data.nextId, 2);
      // tool calls do not add entries: the tool result carries the snapshot
      const n = entries.length;
      controller.run({ action: "create", subject: "B" });
      assert.equal(entries.length, n);
    });
  });

  describe("labels and widget", () => {
    it("writes pi.tasks and pi.tasknow on the parent terminal after every change", async () => {
      const { run } = setup();
      await run({ action: "create", subject: "First" });
      assert.deepEqual(labelCalls().at(-1)!.args, ["label", "t1", "pi.tasks=0/1", "pi.tasknow="]);
      await run({ action: "create", subject: "Second" });
      await run({ action: "update", id: "1", status: "in_progress" });
      assert.deepEqual(lastLabel(), ["pi.tasks=0/2", "pi.tasknow=#1 First"]);
      await run({ action: "update", id: "2", status: "in_progress" });
      assert.deepEqual(lastLabel(), ["pi.tasks=0/2", "pi.tasknow=#1 First +1"]);
      await run({ action: "update", id: "1", status: "completed" });
      assert.deepEqual(lastLabel(), ["pi.tasks=1/2", "pi.tasknow=#2 Second"]);
      // cancelled tasks do not count in the total
      await run({ action: "update", id: "2", status: "cancelled" });
      assert.deepEqual(lastLabel(), ["pi.tasks=1/1", "pi.tasknow="]);
    });

    it("does not rewrite labels that did not change", async () => {
      const { run } = setup();
      await run({ action: "create", subject: "A" });
      const n = labelCalls().length;
      await run({ action: "list" });
      await run({ action: "update", id: "1", description: "more" });
      assert.equal(labelCalls().length, n);
    });

    it("pi.tasknow skips tasks that have a child owner", () => {
      setup();
      const controller = (subagentsModule as any).__test__.getTaskController();
      controller.run({ action: "create", subject: "A" });
      controller.run({ action: "create", subject: "B" });
      controller.claim("1", "Worker (ab12)");
      controller.run({ action: "update", id: "2", status: "in_progress" });
      assert.deepEqual(lastLabel(), ["pi.tasks=0/2", "pi.tasknow=#2 B"]);
    });

    it("a failing hc label does not break the tool, and is retried on the next change", async () => {
      const { run } = setup();
      let fail = true;
      __setHcExec({
        sync: (file, args) => {
          calls.push({ file, args });
          if (fail) throw new Error("hc down");
          return "";
        },
        async: async () => "",
      });
      const out = await run({ action: "create", subject: "A" });
      assert.equal(out.details.error, undefined);
      assert.equal(out.details.tasks.length, 1);
      fail = false;
      await run({ action: "list" });
      assert.deepEqual(lastLabel(), ["pi.tasks=0/1", "pi.tasknow="]);
    });

    it("no labels are written outside Herdr (no HC_TERMINAL_ID)", async () => {
      delete process.env.HC_TERMINAL_ID;
      const { run } = setup();
      await run({ action: "create", subject: "A" });
      assert.equal(labelCalls().length, 0);
    });

    it("widget: checklist in id order incl. struck completed; none when empty", async () => {
      const { run, widgets, ctx, handlers } = setup();
      handlers.session_start({ reason: "startup" }, ctx);
      assert.equal(widgets.at(-1), undefined);
      await run({ action: "create", subject: "Blocker" });
      await run({ action: "create", subject: "Waits", blockedBy: ["1"] });
      await run({ action: "create", subject: "Free" });
      await run({ action: "create", subject: "Doing" });
      await run({ action: "update", id: "4", status: "in_progress", activeForm: "Doing it" });
      await run({ action: "create", subject: "Done" });
      await run({ action: "update", id: "5", status: "completed" });
      const lines = widgets.at(-1)!;
      assert.equal(lines.length, 7); // 5 rows + 2 borders
      assert.ok(lines.every((l) => visibleWidth(l) === 80));
      assert.match(lines[0], /^╭─ ▾ Tasks ─+ 1\/5 done ─╮$/);
      assert.deepEqual(boxRows(lines), [
        "○ #1 Blocker",
        "· #2 Waits (blocked by #1)",
        "○ #3 Free",
        "▶ #4 Doing it",
        "✓ ~#5 Done~",
      ]);
    });

    it("widget never exceeds 9 lines (7 rows + borders)", async () => {
      const { run, widgets, handlers, ctx } = setup();
      handlers.session_start({ reason: "startup" }, ctx);
      for (let i = 1; i <= 12; i++) await run({ action: "create", subject: `T${i}` });
      const lines = widgets.at(-1)!;
      assert.equal(lines.length, 9);
      assert.match(lines[0], /0\/12 done/);
      assert.match(boxRows(lines).at(-1)!, /\+6 more/);
    });

    describe("renderTaskWidgetLines", () => {
      const build = (specs: Array<[string, string?, string[]?]>) => {
        const store = new TaskStore();
        for (const [subject, status, blockedBy] of specs) {
          const t = store.create({ subject, blockedBy });
          if (status) store.update({ id: t.id, status });
        }
        return store;
      };
      const style = { strike: (t: string) => `~${t}~` };
      // Markers so tests can assert colours without ANSI.
      const marks = {
        strike: (t: string) => `~${t}~`,
        dim: (t: string) => `<dim>${t}</dim>`,
        border: (t: string) => `<bd>${t}</bd>`,
        info: (t: string) => `<info>${t}</info>`,
        active: (t: string) => `<act>${t}</act>`,
        error: (t: string) => `<err>${t}</err>`,
      };
      const sample = () =>
        build([
          ["Setup", "completed"], ["Build", "in_progress"], ["Test"],
          ["Ship", undefined, ["3"]], ["Lint", "failed"],
        ]);

      it("3 done, 1 doing, 2 ready, 1 blocked: drops oldest done into one row when short", () => {
        const store = build([
          ["a", "completed"], ["b", "completed"], ["c", "completed"],
          ["d", "in_progress"], ["e"], ["f"], ["g", undefined, ["5"]],
        ]);
        assert.deepEqual(renderTaskWidgetLines(store, 7, style), [
          "✓ ~#1 a~", "✓ ~#2 b~", "✓ ~#3 c~",
          "▶ #4 d", "○ #5 e", "○ #6 f", "· #7 g (blocked by #5)",
        ]);
        assert.deepEqual(renderTaskWidgetLines(store, 5, style), [
          "✓ 3 done", "▶ #4 d", "○ #5 e", "○ #6 f", "· #7 g (blocked by #5)",
        ]);
        assert.deepEqual(renderTaskWidgetLines(store, 6, style), [
          "✓ 2 done", "✓ ~#3 c~", "▶ #4 d", "○ #5 e", "○ #6 f", "· #7 g (blocked by #5)",
        ]);
      });

      it("failed shows ✗ unstruck; cancelled hidden; open overflow keeps +N more", () => {
        const store = build([["a", "failed"], ["b", "cancelled"], ["c", "completed"]]);
        assert.deepEqual(renderTaskWidgetLines(store, 5, style), ["✗ #1 a", "✓ ~#3 c~"]);
        const many = build(Array.from({ length: 8 }, (_, i) => [`t${i}`] as [string]));
        const lines = renderTaskWidgetLines(many, 5)!;
        assert.equal(lines.length, 5);
        assert.match(lines[4], /… \+4 more/);
      });

      it("open tasks fill the room exactly: no done row, never over maxLines", () => {
        const store = build([
          ["a", "completed"], ["b", "completed"],
          ["c"], ["d"], ["e"], ["f"], ["g"], ["h"],
        ]);
        assert.deepEqual(renderTaskWidgetLines(store, 6, style), [
          "○ #3 c", "○ #4 d", "○ #5 e", "○ #6 f", "○ #7 g", "○ #8 h",
        ]);
        for (let max = 0; max <= 9; max++) {
          assert.ok(renderTaskWidgetLines(store, max)!.length <= max, `maxLines ${max}`);
        }
      });

      it("identity default style: plain text; empty store gives undefined", () => {
        assert.deepEqual(renderTaskWidgetLines(build([["a", "completed"]])), ["✓ #1 a"]);
        assert.equal(renderTaskWidgetLines(new TaskStore()), undefined);
        assert.equal(renderTaskWidgetBox(new TaskStore(), 60), undefined);
      });

      it("applies colours per status through the injected style", () => {
        assert.deepEqual(renderTaskWidgetLines(sample(), 7, marks), [
          "<dim>✓ ~#1 Setup~</dim>",
          "<act>▶ #2 Build</act>",
          "○ #3 Test",
          "<dim>· #4 Ship (blocked by #3)</dim>",
          "<err>✗ #5 Lint</err>",
        ]);
      });

      it("box: border shape and exact width at several widths", () => {
        for (const width of [TASK_BOX_MIN_WIDTH, 30, 60, 100]) {
          const lines = renderTaskWidgetBox(sample(), width)!;
          assert.equal(lines.length, 7, `height at ${width}`); // 5 rows + 2 borders
          for (const l of lines) assert.equal(visibleWidth(l), width, `width ${width}: ${l}`);
          assert.match(lines[0], /^╭─ ▾ Tasks ─* 1\/5 done ─╮$/);
          assert.match(lines.at(-1)!, /^╰─+╯$/);
          for (const l of lines.slice(1, -1)) assert.match(l, /^│ .* │$/);
        }
      });

      it("box: rows are cut to the width, borders stay aligned", () => {
        const store = build([["x".repeat(200), "in_progress"]]);
        const lines = renderTaskWidgetBox(store, 40)!;
        assert.equal(lines.length, 3);
        for (const l of lines) assert.equal(visibleWidth(l), 40);
        assert.match(lines[1].replace(/\x1b\[[0-9;]*m/g, ""), /^│ ▶ #1 x+\.\.\. │$/);
      });

      it("box: border and title use border, count info, ▶ active, ✗ error, completed dim and struck", () => {
        const lines = renderTaskWidgetBox(sample(), 60, marks)!;
        assert.match(lines[0], /^<bd>╭─ ▾ Tasks ─+ <\/bd><info>1\/5 done<\/info><bd> ─╮<\/bd>$/);
        assert.ok(lines.at(-1)!.startsWith("<bd>╰") && lines.at(-1)!.endsWith("╯</bd>"));
        assert.ok(lines[1].startsWith("<bd>│</bd> <dim>✓ ~#1 Setup~</dim>"));
        assert.ok(lines[1].endsWith(" <bd>│</bd>"));
        assert.match(lines[2], /<act>▶ #2 Build<\/act>/);
        assert.match(lines[3], /^<bd>│<\/bd> ○ #3 Test +<bd>│<\/bd>$/);
        assert.match(lines[4], /<dim>· #4 Ship \(blocked by #3\)<\/dim>/);
        assert.match(lines[5], /<err>✗ #5 Lint<\/err>/);
      });

      it("box: row colours do not change the width", () => {
        const plain = renderTaskWidgetBox(sample(), 60)!;
        const coloured = renderTaskWidgetBox(sample(), 60, {
          strike: (t) => `\x1b[9m${t}\x1b[29m`,
          dim: (t) => `\x1b[2m${t}\x1b[22m`,
          border: (t) => `\x1b[38;2;142;192;124m${t}\x1b[39m`,
          info: (t) => `\x1b[2m${t}\x1b[22m`,
          active: (t) => `\x1b[33m${t}\x1b[39m`,
          error: (t) => `\x1b[31m${t}\x1b[39m`,
        })!;
        assert.deepEqual(coloured.map((l) => visibleWidth(l)), plain.map((l) => visibleWidth(l)));
      });

      it("box: the ✓ N done fold appears inside the box when room is short; info counts all", () => {
        const store = build([
          ["a", "completed"], ["b", "completed"], ["c", "completed"],
          ["d", "in_progress"], ["e"], ["f"], ["g", undefined, ["5"]],
        ]);
        const lines = renderTaskWidgetBox(store, 60, {}, 5)!;
        assert.match(lines[0], /3\/7 done/);
        assert.deepEqual(boxRows(lines), [
          "✓ 3 done", "▶ #4 d", "○ #5 e", "○ #6 f", "· #7 g (blocked by #5)",
        ]);
        assert.equal(lines.length, 7);
      });

      it("box: at most maxLines rows plus 2 borders (default 9 lines)", () => {
        const many = build(Array.from({ length: 20 }, (_, i) => [`t${i}`] as [string]));
        assert.equal(renderTaskWidgetBox(many, 60)!.length, 9);
        assert.equal(renderTaskWidgetBox(many, 60, {}, 3)!.length, 5);
      });

      it("box: cancelled tasks are hidden and not counted", () => {
        const store = build([["a", "cancelled"], ["b", "completed"]]);
        const lines = renderTaskWidgetBox(store, 60)!;
        assert.match(lines[0], /1\/1 done/);
        assert.deepEqual(boxRows(lines), ["✓ #2 b"]);
      });

      it("narrow terminal: unboxed lines cut to the width", () => {
        const width = TASK_BOX_MIN_WIDTH - 1;
        const lines = renderTaskWidgetBox(sample(), width)!;
        assert.equal(lines[0], "▾ Tasks 1/5");
        assert.equal(lines.length, 6);
        assert.ok(!lines.some((l) => /[╭╮╰╯│]/.test(l)));
        for (const l of lines) assert.ok(visibleWidth(l) <= width, l);
        assert.deepEqual(renderTaskWidgetBox(sample(), 0), []);
        for (const w of [1, 2, 5]) {
          for (const l of renderTaskWidgetBox(sample(), w)!) assert.ok(visibleWidth(l) <= w);
        }
        // exactly the minimum width still boxes
        assert.match(renderTaskWidgetBox(sample(), TASK_BOX_MIN_WIDTH)![0], /^╭.*╮$/);
      });
    });

    it("/tasks list shows the full list", async () => {
      const { run, commands, ctx, notes } = setup();
      await run({ action: "create", subject: "A" });
      await commands.tasks.handler("list", ctx);
      assert.match(notes[0], /#1 \[pending\] ready A/);
    });
  });

  describe("tasks widget: colours, collapse and order", () => {
    const build = (specs: Array<[string, string?, string[]?]>) => {
      const store = new TaskStore();
      for (const [subject, status, blockedBy] of specs) {
        const t = store.create({ subject, blockedBy });
        if (status) store.update({ id: t.id, status });
      }
      return store;
    };
    const sample = () =>
      build([["Setup", "completed"], ["Build", "in_progress"], ["Test"], ["Ship", undefined, ["3"]], ["Lint", "failed"]]);
    /** Theme that wraps text in its token name, so a test sees which token coloured what. */
    const tokenTheme = { strikethrough: (t: string) => `~${t}~`, fg: (n: string, t: string) => `<${n}>${t}</${n}>` };
    const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
    const mouse = (type: string, y: number, button = "left") => ({
      type, button, x: 3, y, screenX: 3, screenY: 20 + y, width: 80, height: 7, shift: false, alt: false, ctrl: false,
    });
    const uiFile = () => join(agentDir, "subagents-ui.json");
    const lastTasks = (s: ReturnType<typeof setup>) => s.mounts.filter((m) => m.key === "tasks").at(-1)!.factory({}, plainTheme);
    const fakeRunning = () => (subagentsModule as any).__test__.runningSubagents.set("r1", { id: "r1", name: "W", startTime: Date.now() });
    afterEach(() => (subagentsModule as any).__test__.runningSubagents.clear());

    it("gruvbox tokens: border and title syntaxKeyword (purple), count muted, ▶ warning, ✗ error, ✓ dim+struck, · dim, ○ plain", async () => {
      const { run, mounts, handlers, ctx } = setup();
      handlers.session_start({ reason: "startup" }, ctx);
      for (const [subject, status, blockedBy] of [["Setup", "completed"], ["Build", "in_progress"], ["Test"], ["Ship", undefined, ["3"]], ["Lint", "failed"]] as any[]) {
        const created = await run({ action: "create", subject, blockedBy });
        if (status) await run({ action: "update", id: created.details.taskId, status });
      }
      const lines = mounts.filter((m) => m.key === "tasks").at(-1)!.factory({}, tokenTheme).render(60);
      assert.match(lines[0], /^<syntaxKeyword>╭─ ▾ Tasks ─+ <\/syntaxKeyword><muted>1\/5 done<\/muted><syntaxKeyword> ─╮<\/syntaxKeyword>$/);
      assert.match(lines.at(-1), /^<syntaxKeyword>╰─+╯<\/syntaxKeyword>$/);
      assert.match(lines[1], /^<syntaxKeyword>│<\/syntaxKeyword> <dim>✓ ~#1 Setup~<\/dim> +<syntaxKeyword>│<\/syntaxKeyword>$/);
      assert.match(lines[2], /<warning>▶ #2 Build<\/warning>/);
      assert.match(lines[3], /^<syntaxKeyword>│<\/syntaxKeyword> ○ #3 Test +<syntaxKeyword>│<\/syntaxKeyword>$/);
      assert.match(lines[4], /<dim>· #4 Ship \(blocked by #3\)<\/dim>/);
      assert.match(lines[5], /<error>✗ #5 Lint<\/error>/);
      // The Subagents box keeps its own blue border; no theme token is used there.
      assert.doesNotMatch(lines.join(""), /<accent>/);
    });

    it("collapsed line: one line, never wider than the width (1-220), hint only when it fits", () => {
      const hint = "ctrl+alt+t";
      const ansi = {
        strike: (t: string) => `\x1b[9m${t}\x1b[29m`,
        dim: (t: string) => `\x1b[2m${t}\x1b[22m`,
        border: (t: string) => `\x1b[36m${t}\x1b[39m`,
        info: (t: string) => `\x1b[2m${t}\x1b[22m`,
        active: (t: string) => `\x1b[33m${t}\x1b[39m`,
      };
      const long = build([["a", "completed"], ["Inbox sidebar with a long subject that does not fit", "in_progress"]]);
      for (const store of [sample(), long]) {
        for (let w = 1; w <= 220; w++) {
          for (const style of [{}, ansi]) {
            const lines = renderTaskWidgetCollapsed(store, w, style, hint)!;
            assert.equal(lines.length, 1, `width ${w}`);
            assert.ok(visibleWidth(lines[0]) <= w, `width ${w}: ${lines[0]}`);
          }
        }
      }
      assert.deepEqual(renderTaskWidgetCollapsed(sample(), 0), []);
      assert.equal(renderTaskWidgetCollapsed(new TaskStore(), 80), undefined);
      assert.deepEqual(renderTaskWidgetCollapsed(sample(), 120, {}, hint), ["╶ ▸ Tasks 1/5 done · ▶ #2 Build · ctrl+alt+t ╴"]);
      // Hint dropped first, then the task text is cut.
      assert.deepEqual(renderTaskWidgetCollapsed(sample(), 35, {}, hint), ["╶ ▸ Tasks 1/5 done · ▶ #2 Build ╴"]);
      const cut = renderTaskWidgetCollapsed(long, 40, {}, hint)![0];
      assert.match(cut, /^╶ ▸ Tasks 1\/2 done · ▶ #2 Inbox.*… ╴$/);
      assert.equal(visibleWidth(cut), 40);
      // No task in progress: the next ready one. Nothing open: only the count.
      assert.deepEqual(renderTaskWidgetCollapsed(build([["a", "completed"], ["b"]]), 80), ["╶ ▸ Tasks 1/2 done · ○ #2 b ╴"]);
      assert.deepEqual(renderTaskWidgetCollapsed(build([["a", "completed"]]), 80), ["╶ ▸ Tasks 1/1 done ╴"]);
    });

    it("a left click on the title line toggles; other lines, other buttons and drags pass through", async () => {
      const s = setup();
      s.handlers.session_start({ reason: "startup" }, s.ctx);
      await s.run({ action: "create", subject: "A" });
      await s.run({ action: "update", id: "1", status: "in_progress" });
      const widget = lastTasks(s);
      assert.equal(widget.render(80).length, 3);
      for (const type of ["press", "release", "click"]) assert.equal(widget.handleMouse(mouse(type, 1)), undefined);
      assert.equal(widget.handleMouse(mouse("click", 0, "right")), undefined);
      assert.equal(widget.handleMouse(mouse("drag", 0)), undefined);
      assert.equal(widget.render(80).length, 3, "still expanded");

      // Pi sends press, release, then click to the component that handled the press.
      assert.equal(widget.handleMouse(mouse("press", 0)).handled, true);
      assert.equal(widget.handleMouse(mouse("release", 0)).handled, true);
      assert.equal(widget.handleMouse(mouse("click", 0)).handled, true);
      const collapsed = widget.render(80).map(strip);
      assert.deepEqual(collapsed, ["╶ ▸ Tasks 0/1 done · ▶ #1 A · ctrl+alt+t ╴"]);
      widget.handleMouse(mouse("click", 0));
      assert.match(strip(widget.render(80)[0]), /^╭─ ▾ Tasks/);
    });

    it("pi-tui routes a click in the widget container to the Tasks title line", async () => {
      const { Container, Spacer } = await import("@earendil-works/pi-tui");
      const s = setup();
      s.handlers.session_start({ reason: "startup" }, s.ctx);
      await s.run({ action: "create", subject: "A" });
      const widget = lastTasks(s);
      // Like Pi's above-editor container: a spacer line, then the widgets.
      const container = new Container();
      container.addChild(new Spacer(1));
      container.addChild(widget);
      container.render(80);
      const at = (y: number) => ({ ...mouse("press", y), height: 4 });
      assert.equal(container.handleMouse(at(2)), undefined, "a row line is not consumed");
      const hit = container.handleMouse(at(1));
      assert.equal(hit?.handled, true);
      assert.equal(hit?.target.component, widget);
      container.handleMouse({ ...at(1), type: "click" });
      assert.equal(widget.render(80).length, 1);
    });

    it("the collapsed state persists in subagents-ui.json and loads on the next start", async () => {
      const first = setup();
      first.handlers.session_start({ reason: "startup" }, first.ctx);
      await first.run({ action: "create", subject: "A" });
      lastTasks(first).handleMouse(mouse("click", 0));
      assert.deepEqual(JSON.parse(readFileSync(uiFile(), "utf8")), { tasksCollapsed: true });

      // /reload or a new session loads the extension again.
      const second = setup();
      second.handlers.session_start({ reason: "reload" }, second.ctx);
      await second.run({ action: "create", subject: "B" });
      assert.equal(second.widgets.at(-1)!.length, 1);
      await second.commands.tasks.handler("", second.ctx);
      assert.deepEqual(JSON.parse(readFileSync(uiFile(), "utf8")), { tasksCollapsed: false });
      assert.ok(second.widgets.at(-1)!.length > 1);

      // Other keys in the file are kept; a broken file means expanded.
      writeFileSync(uiFile(), JSON.stringify({ other: 1, tasksCollapsed: true }));
      const third = setup();
      await third.commands.tasks.handler("", third.ctx); // empty list: only says so
      assert.match(third.notes.at(-1)!, /No tasks/);
      third.handlers.session_start({ reason: "startup" }, third.ctx);
      await third.run({ action: "create", subject: "C" });
      await third.commands.tasks.handler("", third.ctx);
      assert.deepEqual(JSON.parse(readFileSync(uiFile(), "utf8")), { other: 1, tasksCollapsed: false });
      writeFileSync(uiFile(), "{not json");
      const fourth = setup();
      fourth.handlers.session_start({ reason: "startup" }, fourth.ctx);
      await fourth.run({ action: "create", subject: "D" });
      assert.ok(fourth.widgets.at(-1)!.length > 1);
    });

    it("registers the ctrl+alt+t shortcut and /tasks toggles; a child registers neither", async () => {
      const s = setup();
      s.handlers.session_start({ reason: "startup" }, s.ctx);
      assert.deepEqual(Object.keys(s.shortcuts), ["ctrl+alt+t"]);
      assert.match(s.shortcuts["ctrl+alt+t"].description, /Tasks box/);
      await s.run({ action: "create", subject: "A" });
      await s.shortcuts["ctrl+alt+t"].handler(s.ctx);
      assert.equal(s.widgets.at(-1)!.length, 1);
      await s.commands.tasks.handler("", s.ctx);
      assert.equal(s.widgets.at(-1)!.length, 3);

      process.env.PI_SUBAGENT_ID = "child1";
      const child = setup();
      assert.deepEqual(Object.keys(child.shortcuts), []);
      assert.equal(child.commands.tasks, undefined);
    });

    it("on ui:widget-shown, re-mounts Tasks then Subagents (only those shown); shutdown unsubscribes", async () => {
      const s = setup();
      s.handlers.session_start({ reason: "startup" }, s.ctx);
      const shown = () => s.busHandlers["ui:widget-shown"]({ key: "heads-up" });
      const keys = () => s.mounts.splice(0).map((m) => m.key);

      keys();
      shown();
      assert.deepEqual(keys(), [], "nothing shown: nothing re-mounted");

      await s.run({ action: "create", subject: "A" });
      keys();
      shown();
      assert.deepEqual(keys(), ["tasks"]);

      fakeRunning();
      shown();
      assert.deepEqual(keys(), ["tasks", "subagent-status"]);

      // A tasks refresh re-mounts Subagents right after Tasks.
      await s.run({ action: "update", id: "1", status: "in_progress" });
      assert.deepEqual(keys(), ["tasks", "subagent-status"]);

      // A new session_start does not subscribe twice.
      s.handlers.session_start({ reason: "new" }, s.ctx);
      assert.deepEqual(s.unsubscribed, ["ui:widget-shown"]);
      assert.equal(typeof s.busHandlers["ui:widget-shown"], "function");
      s.handlers.session_shutdown({}, s.ctx);
      assert.deepEqual(s.unsubscribed, ["ui:widget-shown", "ui:widget-shown"]);
      assert.equal(s.busHandlers["ui:widget-shown"], undefined);
    });

    it("a stale ctx on the event or a refresh does not throw", async () => {
      const s = setup();
      s.handlers.session_start({ reason: "startup" }, s.ctx);
      await s.run({ action: "create", subject: "A" });
      fakeRunning();
      const handler = s.busHandlers["ui:widget-shown"];
      for (const key of ["hasUI", "ui"]) {
        Object.defineProperty(s.ctx, key, { get() { throw new Error("This extension ctx is stale"); } });
      }
      assert.doesNotThrow(() => handler({ key: "heads-up" }));
      await assert.doesNotReject(s.run({ action: "update", id: "1", status: "in_progress" }));
      await assert.doesNotReject(s.shortcuts["ctrl+alt+t"].handler(s.ctx));
    });
  });

  describe("rebuild from the session branch", () => {
    const toolEntry = (tasks: any[], nextId: number) => ({
      type: "message",
      message: { role: "toolResult", toolName: "task", details: { action: "list", tasks, nextId } },
    });
    const snapEntry = (tasks: any[], nextId: number) => ({
      type: "custom",
      customType: "task-snapshot",
      data: { tasks, nextId },
    });
    const task = (id: string, status: string, extra: any = {}) => ({ id, subject: `S${id}`, status, blockedBy: [], ...extra });

    it("session_start and session_tree load the last snapshot on the branch", async () => {
      const { handlers, ctx, state, run } = setup();
      state.branch = [
        { type: "message", message: { role: "user" } },
        toolEntry([task("1", "pending")], 2),
        snapEntry([task("1", "in_progress", { owner: "W (a)" })], 2),
        { type: "message", message: { role: "toolResult", toolName: "other", details: { tasks: [] } } },
      ];
      handlers.session_start({ reason: "resume" }, ctx);
      assert.equal((await run({ action: "get", id: "1" })).details.tasks[0].status, "in_progress");

      // the last entry wins, whether it is a tool result or a custom entry
      state.branch = [snapEntry([task("1", "in_progress")], 2), toolEntry([task("1", "completed"), task("2", "pending")], 3)];
      handlers.session_tree({}, ctx);
      const list = await run({ action: "list" });
      assert.deepEqual(list.details.tasks.map((t: any) => t.status), ["completed", "pending"]);
      assert.equal(list.details.nextId, 3);
      const created = await run({ action: "create", subject: "next" });
      assert.equal(created.details.taskId, "3");
    });

    it("a branch without snapshots gives an empty list; labels and widget follow", async () => {
      const { handlers, ctx, state, run, widgets } = setup();
      await run({ action: "create", subject: "A" });
      state.branch = [];
      handlers.session_tree({}, ctx);
      assert.equal((await run({ action: "list" })).content[0].text, "No tasks.");
      assert.equal(widgets.at(-1), undefined);
      assert.deepEqual(lastLabel(), ["pi.tasks=", "pi.tasknow="]);
    });

    it("resume restores labels on the parent terminal", () => {
      const { handlers, ctx, state } = setup();
      state.branch = [snapEntry([task("1", "completed"), task("2", "in_progress")], 3)];
      handlers.session_start({ reason: "resume" }, ctx);
      assert.deepEqual(lastLabel(), ["pi.tasks=1/2", "pi.tasknow=#2 S2"]);
    });
  });

  describe("guidelines and reminder", () => {
    const asst = (tool?: string) => ({
      type: "message",
      message: { role: "assistant", content: tool ? [{ type: "toolCall", name: tool }] : [{ type: "text", text: "x" }] },
    });
    const turns = (n: number, tool?: string) => Array.from({ length: n }, () => asst(tool));
    const snapEntry = (tasks: any[], nextId: number) => ({ type: "custom", customType: "task-snapshot", data: { tasks, nextId } });
    const task = (id: string, status: string) => ({ id, subject: `S${id}`, status, blockedBy: [] });
    const reminderEntry = { type: "custom_message", customType: "task-reminder" };
    const saved = process.env.PI_SUBAGENT_TASK_REMINDER;
    afterEach(() => restoreEnvVar("PI_SUBAGENT_TASK_REMINDER", saved));
    const fire = (s: ReturnType<typeof setup>) => s.handlers.before_agent_start({}, s.ctx);

    it("registers short guidelines and each bullet names task", () => {
      const { tool } = setup();
      assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
      for (const g of tool.promptGuidelines) assert.match(g, /`task`|\btask\b/);
      assert.ok(tool.promptGuidelines.join("").length / 4 < 200);
    });

    it("counts turns: fires at 10, not at 9", () => {
      assert.equal(shouldRemindAboutTasks(turns(10)), true);
      assert.equal(shouldRemindAboutTasks(turns(9)), false);
    });

    it("does not fire when a task call is within 10 turns", () => {
      assert.equal(shouldRemindAboutTasks([...turns(5), asst("task"), ...turns(9)]), false);
      assert.equal(shouldRemindAboutTasks([...turns(5), asst("task"), ...turns(10)]), true);
    });

    it("does not fire within 10 turns after a reminder", () => {
      assert.equal(shouldRemindAboutTasks([...turns(20), reminderEntry, ...turns(9)]), false);
      assert.equal(shouldRemindAboutTasks([...turns(20), reminderEntry, ...turns(10)]), true);
    });

    it("hook returns a hidden message with the list when tasks exist", () => {
      const s = setup([...turns(10)]);
      const empty = fire(s);
      assert.equal(empty.message.customType, "task-reminder");
      assert.equal(empty.message.display, false);
      assert.doesNotMatch(empty.message.content, /#1\./);
      s.state.branch = [snapEntry([task("1", "pending"), task("2", "in_progress")], 3), ...turns(10)];
      s.handlers.session_start({ reason: "resume" }, s.ctx);
      const withList = fire(s);
      assert.match(withList.message.content, /#1\. \[pending\] S1/);
      assert.match(withList.message.content, /#2\. \[in_progress\] S2/);
    });

    it("hook stays quiet under 10 turns, when off, or when task is inactive", () => {
      assert.equal(fire(setup(turns(9))), undefined);
      process.env.PI_SUBAGENT_TASK_REMINDER = "off";
      assert.equal(fire(setup(turns(10))), undefined);
      delete process.env.PI_SUBAGENT_TASK_REMINDER;
      const s = setup(turns(10));
      s.active.list = ["subagent"];
      assert.equal(fire(s), undefined);
    });

    it("no reminder in a child", () => {
      process.env.PI_SUBAGENT_ID = "child1";
      const s = setup(turns(10));
      assert.equal(s.tool, undefined);
      assert.equal(s.handlers.before_agent_start ? fire(s) : undefined, undefined);
    });
  });
});
