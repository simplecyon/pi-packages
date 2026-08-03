/**
 * permission-mode.ts
 *
 * Runtime for pi-safe-operation's permission modes. Phase 2 ships the "plan"
 * strategy: a plan-first workflow ported from pi's official plan-mode example
 * and adapted for this package:
 *
 *   - namespaced customTypes, so it never clashes with a standalone install of
 *     the example plan-mode extension;
 *   - config-driven entry: permissionMode "plan" starts fresh sessions in the
 *     planning phase (the --plan flag and /plan command remain user overrides);
 *   - a PlanModeController exposed to the main tool_call gate, which hard-blocks
 *     write tools and non-allowlisted bash during the planning phase;
 *   - safe_delete joins edit/write in the disabled-tool set, because deletion
 *     is a mutation and must wait for plan approval.
 *
 * safe-operation's hard blocks always run first; this module only governs the
 * plan-first workflow, the read-only tool gate, and the approval gate.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type InteractionMode = "chat" | "plan" | "accept-edits" | "auto";

const ASK_USER_QUESTION_REQUEST_EVENT = "simplecyon:ask-user-question:request";
const TASKS_AVAILABLE_EVENT = "simplecyon:session-tasks:available";
const TASKS_SYNC_EVENT = "simplecyon:session-tasks:sync";

// ---------------------------------------------------------------------------
// Plan extraction and command allowlist
// (ported from pi examples/extensions/plan-mode/utils.ts)
// ---------------------------------------------------------------------------

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

/** True when a bash command is read-only enough for the planning phase. */
export function isSafePlanCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
  const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
  return !isDestructive && isSafe;
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((todo) => todo.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}

// ---------------------------------------------------------------------------
// Plan-mode state machine
// ---------------------------------------------------------------------------

const PERSIST_TYPE = "pi-safe-operation:plan-mode";
const PLAN_CONTEXT_TYPE = "pi-safe-operation:plan-mode-context";
const EXEC_CONTEXT_TYPE = "pi-safe-operation:plan-execution-context";
const PLAN_LIST_TYPE = "pi-safe-operation:plan-todo-list";
const EXECUTE_TYPE = "pi-safe-operation:plan-mode-execute";
const COMPLETE_TYPE = "pi-safe-operation:plan-complete";
const PLAN_MARKER = "[PLAN MODE ACTIVE]";
const EXEC_MARKER = "[EXECUTING PLAN";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "safe_delete"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

export interface PlanModeController {
  /** True while the agent should be planning: write tools off, bash allowlisted. */
  isPlanningPhase(): boolean;
  /** True while executing an approved plan. */
  isExecutingPlan(): boolean;
  /** Enter the planning phase without relying on a fresh session. */
  enterPlanning(ctx: ExtensionContext): void;
  /** Leave an unapproved planning phase and restore normal tools. */
  exitPlanning(ctx: ExtensionContext): void;
}

interface PersistedPlanState {
  enabled?: boolean;
  todos?: TodoItem[];
  executing?: boolean;
  toolsBeforePlanMode?: string[];
}

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

interface AssistantLike {
  role?: string;
  content?: unknown;
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown[] } {
  const msg = message as AssistantLike | undefined;
  return msg?.role === "assistant" && Array.isArray(msg.content);
}

function getTextContent(message: { content: unknown[] }): string {
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: string; text?: unknown })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function uniqueToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames)];
}

export function setupPermissionMode(
  pi: ExtensionAPI,
  opts: {
    getInteractionMode: () => InteractionMode;
    setInteractionMode?: (mode: InteractionMode, ctx: ExtensionContext) => Promise<void>;
  },
): PlanModeController {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  // Prevent repeated agent_end events from opening duplicate approval pickers
  // for the same plan.
  let approvalPromptOpen = false;
  let toolsBeforePlanMode: string[] | undefined;
  let taskExtensionAvailable = false;

  pi.events.on(TASKS_AVAILABLE_EVENT, () => {
    taskExtensionAvailable = true;
    syncTaskExtension();
  });

  function syncTaskExtension(): void {
    if (!taskExtensionAvailable) return;
    const firstPending = todoItems.find((todo) => !todo.completed)?.step;
    pi.events.emit(TASKS_SYNC_EVENT, {
      tasks: todoItems.map((todo) => ({
        id: `plan-${todo.step}`,
        title: todo.text,
        status: todo.completed ? "completed" : todo.step === firstPending ? "in_progress" : "pending",
      })),
    });
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    if (taskExtensionAvailable) {
      ctx.ui.setStatus("safe-operation-plan", undefined);
      ctx.ui.setWidget("safe-operation-plan-todos", undefined);
      syncTaskExtension();
      return;
    }
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((todo) => todo.completed).length;
      ctx.ui.setStatus("safe-operation-plan", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
    } else if (planModeEnabled) {
      ctx.ui.setStatus("safe-operation-plan", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("safe-operation-plan", undefined);
    }

    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("safe-operation-plan-todos", lines);
    } else {
      ctx.ui.setWidget("safe-operation-plan-todos", undefined);
    }
  }

  function getPlanModeTools(activeToolNames: string[]): string[] {
    return uniqueToolNames([
      ...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
      ...PLAN_MODE_TOOLS,
    ]);
  }

  function getNormalModeTools(activeToolNames: string[]): string[] {
    return uniqueToolNames([
      ...NORMAL_MODE_TOOLS,
      ...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
    ]);
  }

  function enablePlanModeTools(): void {
    if (toolsBeforePlanMode === undefined) {
      toolsBeforePlanMode = pi.getActiveTools();
    }
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
  }

  function restoreNormalModeTools(): void {
    pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
    toolsBeforePlanMode = undefined;
  }

  function persistState(): void {
    pi.appendEntry(PERSIST_TYPE, {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      toolsBeforePlanMode,
    } satisfies PersistedPlanState);
  }

  function enterPlanning(ctx: ExtensionContext): void {
    if (planModeEnabled && !executionMode) return;
    planModeEnabled = true;
    executionMode = false;
    todoItems = [];
    enablePlanModeTools();
    ctx.ui.notify("Plan mode enabled. Write tools disabled until the plan is approved.", "info");
    updateStatus(ctx);
    persistState();
  }

  function exitPlanning(ctx: ExtensionContext): void {
    if (!planModeEnabled || executionMode) return;
    planModeEnabled = false;
    todoItems = [];
    restoreNormalModeTools();
    ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
    updateStatus(ctx);
    persistState();
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled && !executionMode) exitPlanning(ctx);
    else enterPlanning(ctx);
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (plan-first, read-only exploration)",
    handler: async (_args: unknown, ctx: ExtensionContext) => togglePlanMode(ctx),
  });

  pi.registerCommand("todos", {
    description: "Show current plan todo list",
    handler: async (_args: unknown, ctx: ExtensionContext) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx: ExtensionContext) => togglePlanMode(ctx),
  });

  // Guidance is appended to the system prompt rather than stored as a custom
  // session message. The latter can leak raw Runtime instructions into chat.
  function appendGuidance(event: any, guidance: string): { systemPrompt: string } {
    const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    return { systemPrompt: `${base}\n\n${guidance}` };
  }

  pi.on("before_agent_start", async (event) => {
    if (planModeEnabled) {
      return appendGuidance(event, `你处于 Plan mode：这是只读探索阶段，尚未批准任何变更。

限制：edit/write/safe_delete 已禁用；Bash 仅允许只读命令；所有 hard safety block 继续生效。需求存在歧义时，先向用户提问。

完成探索后，以 \`Plan:\` 标题输出编号计划。每一步必须写清目标范围、预期变更、风险或待决事项、验证方式；不要尝试修改文件。用户批准后会明确选择以 Accept edits 或 Auto 执行。`);
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((todo) => !todo.completed);
      const todoList = remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
      return appendGuidance(event, `你正在执行已批准的计划。\n\n剩余步骤：\n${todoList}\n\n按顺序执行，每完成一步在回复中加入 \`[DONE:n]\`。完成前运行计划中承诺的验证。`);
    }

    if (opts.getInteractionMode() === "auto") {
      return appendGuidance(event, `你处于 Auto mode。持续推进，直到验收已验证、没有 policy-compliant 路径，或仅用户能提供偏好、授权或缺失信息。技术不确定性应触发读取、测试和更安全的替代方案。judge 或 policy 拦截是对预期效果的约束：重做方案，不要以等效操作重试，也不要让用户确认 judge 已拒绝的技术操作。`);
    }
  });

  // Filter out stale plan-mode context when neither planning nor executing.
  pi.on("context", async (event) => {
    if (planModeEnabled || executionMode) return;

    return {
      messages: event.messages.filter((message) => {
        const msg = message as { customType?: string; role?: string; content?: unknown };
        if (msg.customType === PLAN_CONTEXT_TYPE || msg.customType === EXEC_CONTEXT_TYPE) return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes(PLAN_MARKER) && !content.includes(EXEC_MARKER);
        }
        if (Array.isArray(content)) {
          return !content.some(
            (block) =>
              (block as { type?: string; text?: string })?.type === "text" &&
              typeof (block as { text?: string }).text === "string" &&
              (((block as { text: string }).text.includes(PLAN_MARKER)) ||
                (block as { text: string }).text.includes(EXEC_MARKER)),
          );
        }
        return true;
      }),
    };
  });

  // Track [DONE:n] progress after each turn during execution.
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
    }
    persistState();
  });

  async function askPlanDecision(ctx: ExtensionContext): Promise<string | undefined> {
    const options = [
      {
        label: "Execute in Auto mode",
        description: "Let the judge model evaluate risky actions; the agent revises and continues without technical approval dialogs.",
      },
      {
        label: "Execute in Accept edits mode",
        description: "Apply ordinary edits automatically; ask you before each flagged operation.",
      },
      {
        label: "Chat about this plan",
        description: "Discuss or revise the plan before making any changes.",
      },
    ];
    let answerResolve: ((value: any) => void) | undefined;
    const answer = new Promise<any>((resolve) => { answerResolve = resolve; });
    const request: any = {
      ctx,
      questions: [{
        header: "Plan",
        question: "The plan is ready. What would you like to do next?",
        options,
      }],
      resolve: answerResolve,
    };
    pi.events.emit(ASK_USER_QUESTION_REQUEST_EVENT, request);
    if (request.handled) {
      const result = await answer;
      return result.answers?.[0]?.selectedLabels?.[0];
    }
    return ctx.ui.select("Plan ready - what next?", options.map((option) => option.label));
  }

  // Approval gate at the end of a planning turn; completion detection during execution.
  pi.on("agent_end", async (event, ctx) => {
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((todo) => todo.completed)) {
        const completedList = todoItems.map((todo) => `~~${todo.text}~~`).join("\n");
        pi.sendMessage(
          { customType: COMPLETE_TYPE, content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        updateStatus(ctx);
        persistState(); // Save cleared state so resume doesn't restore stale execution mode
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find((message) => isAssistantMessage(message));
    if (lastAssistant && isAssistantMessage(lastAssistant)) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) {
        todoItems = extracted;
      }
    }

    if (todoItems.length === 0 || approvalPromptOpen) return;
    persistState();

    updateStatus(ctx);
    approvalPromptOpen = true;
    const choice = await askPlanDecision(ctx);
    approvalPromptOpen = false;

    if (choice === "Execute in Auto mode" || choice === "Execute in Accept edits mode") {
      const firstTodoItem = todoItems[0];
      if (!firstTodoItem) return;

      // Leave the planning phase before updating the interaction mode, so the
      // mode controller does not interpret plan approval as a manual exit.
      planModeEnabled = false;
      executionMode = true;
      restoreNormalModeTools();
      if (choice === "Execute in Auto mode") {
        await opts.setInteractionMode?.("auto", ctx);
      } else {
        await opts.setInteractionMode?.("accept-edits", ctx);
      }
      updateStatus(ctx);
      persistState();

      pi.sendMessage(
        { customType: EXECUTE_TYPE, content: "Execute the approved plan.", display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "Chat about this plan") {
      const refinement = await ctx.ui.editor("Chat about this plan:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // Restore state on session start/resume; config/flag decide fresh sessions.
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries() as unknown as SessionEntryLike[];

    const persisted = entries
      .filter((entry) => entry.type === "custom" && entry.customType === PERSIST_TYPE)
      .pop();
    const persistedData = persisted?.data as PersistedPlanState | undefined;

    if (persistedData) {
      planModeEnabled = persistedData.enabled ?? planModeEnabled;
      todoItems = persistedData.todos ?? todoItems;
      executionMode = persistedData.executing ?? executionMode;
      toolsBeforePlanMode = persistedData.toolsBeforePlanMode ?? toolsBeforePlanMode;
    } else if (opts.getInteractionMode() === "plan") {
      // Fresh session with interactionMode "plan": start in the planning phase.
      planModeEnabled = true;
    }

    // On resume: rebuild [DONE:n] completion from messages after the last
    // execute marker, so previous plans' markers are not double-counted.
    if (persisted && executionMode && todoItems.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].customType === EXECUTE_TYPE) {
          executeIndex = i;
          break;
        }
      }

      const texts: string[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && isAssistantMessage(entry.message)) {
          texts.push(getTextContent(entry.message));
        }
      }
      markCompletedSteps(texts.join("\n"), todoItems);
    }

    if (planModeEnabled) {
      enablePlanModeTools();
    }
    updateStatus(ctx);
  });

  return {
    isPlanningPhase: () => planModeEnabled && !executionMode,
    isExecutingPlan: () => executionMode,
    enterPlanning,
    exitPlanning,
  };
}
