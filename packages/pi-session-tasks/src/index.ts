import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOKEN_ROI_MILESTONE_EVENT } from "@simplecyon/pi-context-core";
import { Type } from "typebox";
import {
	MAX_TASKS,
	MAX_TASK_ID_LENGTH,
	MAX_TASK_TITLE_LENGTH,
	RECOMMENDED_TASK_TITLE_LENGTH,
	cloneTasks,
	deriveTaskUIState,
	diffTasks,
	emptyChanges,
	isTaskSnapshotDetails,
	tasksEqual,
	validateTaskList,
	type SessionPhase,
	type Task,
	type TaskReadDetails,
	type TaskSnapshot,
	type TaskToolDetails,
} from "./model.ts";
import {
	renderReadToolCall,
	renderReadToolResult,
	renderToolCall,
	renderToolResult,
	TaskListComponent,
	TaskWidgetComponent,
} from "./render.ts";

const TOOL_NAME = "update_tasks";
const READ_TOOL_NAME = "get_tasks";
const WIDGET_KEY = "session-tasks";
const UI_ENTRY_TYPE = "session-tasks-ui";
const EXCLUSIVE_UI_CHANNEL = "simplecyon:ui-exclusive";
const TASKS_AVAILABLE_EVENT = "simplecyon:session-tasks:available";
const TASKS_SYNC_EVENT = "simplecyon:session-tasks:sync";

interface ExclusiveUIEvent {
	action: "acquire" | "release";
	token: string;
	source: string;
}

function isExclusiveUIEvent(value: unknown): value is ExclusiveUIEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<ExclusiveUIEvent>;
	return (
		(event.action === "acquire" || event.action === "release") &&
		typeof event.token === "string" &&
		event.token.length > 0 &&
		typeof event.source === "string"
	);
}

interface DismissEntryData {
	action: "dismiss-completed-summary";
	revision: number;
}

const TaskSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			maxLength: MAX_TASK_ID_LENGTH,
			pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
			description: "Stable unique ID within this task list",
		}),
		title: Type.String({
			minLength: 1,
			maxLength: MAX_TASK_TITLE_LENGTH,
			pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
			description:
				`Short verb-object label, ideally 2-6 words and at most ${RECOMMENDED_TASK_TITLE_LENGTH} characters. ` +
				"Longer titles are allowed when technical identifiers require them. Name one observable outcome; omit rationale, implementation detail, sequencing, and ending punctuation.",
		}),
		status: StringEnum(["pending", "in_progress", "completed"] as const),
	},
	{ additionalProperties: false },
);

const UpdateTasksSchema = Type.Object(
	{
		expected_revision: Type.Integer({
			minimum: 0,
			description:
				"Revision returned by get_tasks or the previous successful update_tasks call. Use 0 only when no task list exists.",
		}),
		tasks: Type.Array(TaskSchema, {
			maxItems: MAX_TASKS,
			description: "Complete replacement list. Pass [] to clear tasks.",
		}),
	},
	{ additionalProperties: false },
);

const GetTasksSchema = Type.Object({}, { additionalProperties: false });

function isDismissEntryData(value: unknown): value is DismissEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<DismissEntryData>;
	return (
		data.action === "dismiss-completed-summary" &&
		Number.isInteger(data.revision) &&
		(data.revision ?? 0) > 0
	);
}

function isTaskSyncEvent(value: unknown): value is { tasks: Task[] } {
	if (!value || typeof value !== "object" || !Array.isArray((value as any).tasks)) return false;
	return (value as any).tasks.every(
		(task: any) => task && typeof task.id === "string" && typeof task.title === "string" &&
			(task.status === "pending" || task.status === "in_progress" || task.status === "completed"),
	);
}

function completedCount(tasks: readonly Task[]): number {
	return tasks.filter((task) => task.status === "completed").length;
}

function buildSummary(tasks: readonly Task[], revision: number): string {
	if (tasks.length === 0) return `Task list cleared. Revision: ${revision}.`;
	const done = completedCount(tasks);
	const current = tasks.find((task) => task.status === "in_progress");
	return current
		? `Tasks updated. Revision: ${revision}. ${done}/${tasks.length} completed. Current: ${current.title}`
		: `Tasks completed. Revision: ${revision}. ${done}/${tasks.length} completed.`;
}

function buildTaskList(tasks: readonly Task[], revision: number): string {
	if (tasks.length === 0) return `No tasks. Current revision: ${revision}.`;
	const lines = tasks.map(
		(task) =>
			`${task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]"} ${task.id}: ${task.title}`,
	);
	return [`Current task revision: ${revision}.`, ...lines].join("\n");
}

export default function sessionTasksExtension(pi: ExtensionAPI): void {
	let currentSnapshot: TaskSnapshot | undefined;
	let dismissedRevision: number | undefined;
	let sessionPhase: SessionPhase = "settled";
	let updateQueue: Promise<void> = Promise.resolve();
	const exclusiveUITokens = new Set<string>();
	let latestUIContext: ExtensionContext | undefined;

	pi.events.on(TASKS_SYNC_EVENT, (data) => {
		if (!isTaskSyncEvent(data)) return;
		try {
			validateTaskList(data.tasks);
		} catch {
			return;
		}
		currentSnapshot = {
			revision: (currentSnapshot?.revision ?? 0) + 1,
			tasks: cloneTasks(data.tasks),
		};
		dismissedRevision = undefined;
		if (latestUIContext) renderTaskUI(latestUIContext);
	});
	pi.events.emit(TASKS_AVAILABLE_EVENT, { source: "pi-session-tasks" });

	function currentUIState() {
		return deriveTaskUIState(currentSnapshot, sessionPhase, dismissedRevision);
	}

	function clearUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(WIDGET_KEY, undefined);
	}

	function renderTaskUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		latestUIContext = ctx;
		// The task list belongs in the widget / explicit /tasks view, not in
		// Pi's bottom status line. Clear any footer status left by an older
		// extension version whenever UI state is refreshed.
		ctx.ui.setStatus(WIDGET_KEY, undefined);
		const state = currentUIState();
		const tasks = currentSnapshot?.tasks ?? [];
		if (state === "hidden" || exclusiveUITokens.size > 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => new TaskWidgetComponent(tasks, state, theme),
		);
	}

	pi.events.on(EXCLUSIVE_UI_CHANNEL, (data) => {
		if (!isExclusiveUIEvent(data)) return;
		if (data.action === "acquire") exclusiveUITokens.add(data.token);
		else exclusiveUITokens.delete(data.token);
		if (latestUIContext) renderTaskUI(latestUIContext);
	});

	function reconstructState(ctx: ExtensionContext): void {
		currentSnapshot = undefined;
		dismissedRevision = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const message = entry.message;
				if (
					message.role === "toolResult" &&
					message.toolName === TOOL_NAME &&
					isTaskSnapshotDetails(message.details)
				) {
					currentSnapshot = {
						revision: message.details.revision,
						tasks: cloneTasks(message.details.tasks),
					};
				}
				continue;
			}

			if (
				entry.type === "custom" &&
				entry.customType === UI_ENTRY_TYPE &&
				isDismissEntryData(entry.data)
			) {
				dismissedRevision = entry.data.revision;
			}
		}
	}

	function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
		const result = updateQueue.then(operation, operation);
		updateQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	pi.registerTool({
		name: READ_TOOL_NAME,
		label: "Get Tasks",
		renderShell: "self",
		description:
			"Read the current structured task list and revision for this session. Call this before update_tasks whenever the latest revision is not visible in context.",
		promptSnippet: "Read the current session task list before updating stale or compacted task state",
		parameters: GetTasksSchema,

		async execute() {
			const details: TaskReadDetails = {
				schemaVersion: 1,
				revision: currentSnapshot?.revision ?? 0,
				tasks: cloneTasks(currentSnapshot?.tasks ?? []),
			};
			return {
				content: [{ type: "text" as const, text: buildTaskList(details.tasks, details.revision) }],
				details,
			};
		},

		renderCall(_args, theme) {
			return renderReadToolCall(theme);
		},

		renderResult(result, options, theme) {
			return renderReadToolResult(result, theme, options.expanded);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Update Tasks",
		renderShell: "self",
		description:
			"Create, replace, update, or clear the structured task list for the current session. Submit the complete list and its expected revision each time.",
		promptSnippet: "Track multi-step work with a structured task list for the current session",
		promptGuidelines: [
			"Use update_tasks when work requires 3 or more meaningful steps.",
			"Do not use update_tasks for simple questions or short single-operation requests.",
			`Write each title as a compact verb-object label: ideally 2-6 words and no more than ${RECOMMENDED_TASK_TITLE_LENGTH} characters. ` +
				`The hard limit is ${MAX_TASK_TITLE_LENGTH} characters for titles that need technical identifiers.`,
			"Each title should name one observable outcome. Omit rationale, implementation details, sequencing words, filler, and ending punctuation.",
			"Prefer titles like \"Inspect task prompt\", \"Tighten title rules\", and \"Run focused tests\".",
			"Keep the title unchanged for an existing task ID; routine updates should change only status.",
			"Change a title only when that task's observable outcome materially changes. Do not rephrase titles for style or progress.",
			"Keep exactly one task in_progress while unfinished work remains.",
			"Pass the complete task list on every update_tasks call.",
			"Pass expected_revision from get_tasks or the previous successful update_tasks result.",
			"Call get_tasks first whenever the current list or revision is not visible in context, including after compaction.",
			"When a new user request supersedes an unfinished task list, replace the list or clear it before proceeding.",
		],
		parameters: UpdateTasksSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return enqueueUpdate(async () => {
				const nextTasks = cloneTasks(params.tasks as Task[]);
				validateTaskList(nextTasks);

				const actualRevision = currentSnapshot?.revision ?? 0;
				if (params.expected_revision !== actualRevision) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Task update rejected: expected revision ${params.expected_revision}, ` +
									`but current revision is ${actualRevision}. Call get_tasks and retry.`,
							},
						],
						details: undefined,
					};
				}

				const previousTasks = currentSnapshot?.tasks ?? [];
				if (currentSnapshot && tasksEqual(previousTasks, nextTasks)) {
					const details: TaskToolDetails = {
						schemaVersion: 1,
						revision: currentSnapshot.revision,
						tasks: cloneTasks(currentSnapshot.tasks),
						changes: emptyChanges(),
						unchanged: true,
					};
					return {
						content: [{ type: "text" as const, text: "Tasks unchanged." }],
						details,
					};
				}

				const details: TaskToolDetails = {
					schemaVersion: 1,
					revision: actualRevision + 1,
					tasks: cloneTasks(nextTasks),
					changes: diffTasks(previousTasks, nextTasks),
					unchanged: false,
				};

				currentSnapshot = {
					revision: details.revision,
					tasks: cloneTasks(details.tasks),
				};
				if (details.changes.completed.length > 0) {
					pi.events.emit(TOKEN_ROI_MILESTONE_EVENT, {
						kind: "session_task_completed",
						count: details.changes.completed.length,
					});
				}
				renderTaskUI(ctx);

				return {
					content: [
						{
							type: "text" as const,
							text: buildSummary(details.tasks, details.revision),
						},
					],
					details,
				};
			});
		},

		renderCall(args, theme) {
			return renderToolCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderToolResult(result, theme, options.expanded);
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the full read-only task list for this session",
		handler: async (_args, ctx) => {
			const tasks = currentSnapshot?.tasks ?? [];
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks in this session.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				const lines = tasks.map((task) => `${task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"} ${task.title}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				return new TaskListComponent(tasks, currentUIState(), theme, () => done());
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		exclusiveUITokens.clear();
		sessionPhase = "settled";
		reconstructState(ctx);
		renderTaskUI(ctx);
		pi.events.emit(TASKS_AVAILABLE_EVENT, { source: "pi-session-tasks" });
	});

	pi.on("session_tree", async (_event, ctx) => {
		sessionPhase = "settled";
		reconstructState(ctx);
		renderTaskUI(ctx);
		pi.events.emit(TASKS_AVAILABLE_EVENT, { source: "pi-session-tasks" });
	});

	pi.on("agent_start", async (_event, ctx) => {
		sessionPhase = "running";
		renderTaskUI(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionPhase = "settled";
		renderTaskUI(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const state = currentUIState();
		const humanInput = event.source === "interactive" || event.source === "rpc";
		const submittedWhileIdle = event.streamingBehavior === undefined;

		if (
			state === "completed" &&
			currentSnapshot &&
			humanInput &&
			submittedWhileIdle
		) {
			dismissedRevision = currentSnapshot.revision;
			pi.appendEntry(UI_ENTRY_TYPE, {
				action: "dismiss-completed-summary",
				revision: currentSnapshot.revision,
			} satisfies DismissEntryData);
			renderTaskUI(ctx);
		}

		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUI(ctx);
	});
}
