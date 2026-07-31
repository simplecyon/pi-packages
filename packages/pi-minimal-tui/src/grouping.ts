import type { ToolSummary } from "./summary.ts";

export const GROUPABLE_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);

export interface GroupView {
	hidden: boolean;
	summary?: ToolSummary;
	marker?: "middle" | "last";
	elapsedMs?: number;
}

interface ActionRecord {
	kind: "action";
	id: string;
	name: string;
	isError: boolean;
}

interface BoundaryRecord {
	kind: "boundary";
	elapsedMs?: number;
}

type SequenceRecord = ActionRecord | BoundaryRecord;

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function formatGroupedSummary(toolNames: readonly string[]): ToolSummary | undefined {
	if (toolNames.length < 2) return undefined;

	const bash = toolNames.filter((name) => name === "bash").length;
	const read = toolNames.filter((name) => name === "read").length;
	const search = toolNames.filter((name) => name === "grep" || name === "find").length;
	const list = toolNames.filter((name) => name === "ls").length;
	const clauses: string[] = [];

	if (read) clauses.push(`Read ${countLabel(read, "file")}`);
	if (bash) clauses.push(`${clauses.length ? "ran" : "Ran"} ${countLabel(bash, "bash", "bash")}`);
	if (search) clauses.push(`${clauses.length ? "searched" : "Searched"} ${countLabel(search, "time")}`);
	if (list) clauses.push(`${clauses.length ? "listed" : "Listed"} ${countLabel(list, "directory", "directories")}`);

	return clauses.length ? { verb: clauses.join(", ") } : undefined;
}

function sameView(left: GroupView | undefined, right: GroupView | undefined): boolean {
	return (
		left?.hidden === right?.hidden &&
		left?.summary?.verb === right?.summary?.verb &&
		left?.summary?.detail === right?.summary?.detail &&
		left?.marker === right?.marker &&
		left?.elapsedMs === right?.elapsedMs
	);
}

function messageRole(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as Record<string, unknown>).role;
	return typeof role === "string" ? role : undefined;
}

function messageContent(message: unknown): unknown[] {
	if (!message || typeof message !== "object") return [];
	const content = (message as Record<string, unknown>).content;
	return Array.isArray(content) ? content : [];
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function hasVisibleAssistantContent(block: unknown): boolean {
	const type = stringField(block, "type");
	if (type === "thinking" || type === "toolCall") return false;
	if (type === "text") return Boolean(stringField(block, "text")?.trim());
	return type !== undefined;
}

export class ActionGroupCoordinator {
	private sequence: SequenceRecord[] = [];
	private actions = new Map<string, ActionRecord>();
	private views = new Map<string, GroupView>();
	private invalidators = new Map<string, () => void>();
	private agentStartedAt: number | undefined;
	private turnHadTool = false;
	private lastTurn: { elapsedMs: number | undefined; hadTool: boolean } | undefined;

	reset(): void {
		this.sequence = [];
		this.actions.clear();
		this.views.clear();
		this.invalidators.clear();
		this.agentStartedAt = undefined;
		this.turnHadTool = false;
		this.lastTurn = undefined;
	}

	registerRenderer(toolCallId: string, invalidate: () => void): void {
		this.invalidators.set(toolCallId, invalidate);
	}

	getView(toolCallId: string): GroupView | undefined {
		return this.views.get(toolCallId);
	}

	getLastTurn(): { elapsedMs: number | undefined; hadTool: boolean } | undefined {
		return this.lastTurn;
	}

	addBoundary(): void {
		if (this.sequence.at(-1)?.kind !== "boundary") {
			this.sequence.push({ kind: "boundary" });
		}
	}

	startAgent(startedAt = Date.now()): void {
		this.agentStartedAt = startedAt;
		this.turnHadTool = false;
	}

	finishAgent(finishedAt = Date.now()): void {
		const elapsedMs =
			this.agentStartedAt === undefined ? undefined : Math.max(0, finishedAt - this.agentStartedAt);
		this.agentStartedAt = undefined;
		const lastRecord = this.sequence.at(-1);
		if (lastRecord?.kind === "boundary") {
			lastRecord.elapsedMs = elapsedMs;
		} else {
			this.sequence.push({ kind: "boundary", elapsedMs });
		}
		this.recompute();
		this.lastTurn = { elapsedMs, hadTool: this.turnHadTool };
	}

	recordTool(toolCallId: string, toolName: string): void {
		if (this.actions.has(toolCallId)) return;
		this.turnHadTool = true;
		const action: ActionRecord = { kind: "action", id: toolCallId, name: toolName, isError: false };
		this.actions.set(toolCallId, action);
		this.sequence.push(action);
		this.recompute();
	}

	markError(toolCallId: string, isError = true): void {
		const action = this.actions.get(toolCallId);
		if (!action || action.isError === isError) return;
		action.isError = isError;
		this.recompute();
	}

	recordMessage(message: unknown): void {
		const role = messageRole(message);
		if (role === "user") {
			this.addBoundary();
			return;
		}
		if (role === "toolResult") {
			const record = message as Record<string, unknown>;
			const toolCallId = stringField(message, "toolCallId");
			if (toolCallId && record.isError === true) this.markError(toolCallId);
			return;
		}
		if (role !== "assistant") return;

		for (const block of messageContent(message)) {
			const type = stringField(block, "type");
			if (type === "toolCall") {
				const id = stringField(block, "id", "toolCallId");
				const name = stringField(block, "name", "toolName");
				if (id && name) this.recordTool(id, name);
			} else if (hasVisibleAssistantContent(block)) {
				this.addBoundary();
			}
		}
	}

	rebuild(entries: readonly unknown[]): void {
		this.reset();
		const errorIds = new Set<string>();

		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const message = (entry as Record<string, unknown>).message;
			if (messageRole(message) !== "toolResult") continue;
			const record = message as Record<string, unknown>;
			const id = stringField(message, "toolCallId");
			if (id && record.isError === true) errorIds.add(id);
		}

		// Replay entries in order and reconstruct the agent_start → agent_end
		// lifecycle from persisted `SessionEntry.timestamp` values, so the
		// "Thought for …" duration survives reload/resume/compaction rebuild.
		// A user message starts a run (≈ agent_start); the next user message,
		// a compaction, or a branch_summary entry closes it (≈ agent_end,
		// approximated by the previous entry's persist time — the closest
		// available witness to the live agent_end moment).
		let prevMs: number | undefined;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const message = record.message;
			const role = messageRole(message);
			const type = typeof record.type === "string" ? record.type : undefined;
			const entryMs = parseTimestamp(record.timestamp);
			const closesRun =
				role === "user" || type === "compaction" || type === "branch_summary";
			if (closesRun && this.agentStartedAt !== undefined && prevMs !== undefined) {
				this.finishAgent(prevMs);
			}
			this.recordMessage(message);
			if (role === "user" && entryMs !== undefined) {
				this.startAgent(entryMs);
			}
			if (entryMs !== undefined) prevMs = entryMs;
		}
		if (this.agentStartedAt !== undefined && prevMs !== undefined) {
			this.finishAgent(prevMs);
		}
		for (const id of errorIds) this.markError(id);
	}

	private recompute(): void {
		const nextViews = new Map<string, GroupView>();
		let group: ActionRecord[] = [];

		const flushFinal = (elapsedMs?: number) => {
			const summary = formatGroupedSummary(group.map((action) => action.name));
			for (let index = 0; index < group.length; index += 1) {
				const action = group[index];
				if (!action) continue;
				const view: GroupView = {
					hidden: Boolean(summary) && index < group.length - 1,
					summary: summary && index === group.length - 1 ? summary : undefined,
				};
				if (elapsedMs !== undefined && index === group.length - 1) {
					view.marker = "last";
					view.elapsedMs = elapsedMs;
				}
				nextViews.set(action.id, view);
			}
			group = [];
		};

		for (const record of this.sequence) {
			if (record.kind === "boundary") {
				flushFinal(record.elapsedMs);
			} else if (!GROUPABLE_TOOLS.has(record.name) || record.isError) {
				flushFinal();
				nextViews.set(record.id, { hidden: false });
			} else {
				group.push(record);
			}
		}
		if (this.agentStartedAt === undefined) {
			flushFinal();
		} else {
			const firstVisible = Math.max(0, group.length - 3);
			for (let index = 0; index < group.length; index += 1) {
				const action = group[index];
				if (!action) continue;
				nextViews.set(action.id, {
					hidden: index < firstVisible,
					marker: index === group.length - 1 ? "last" : "middle",
				});
			}
		}

		const previousViews = this.views;
		const changedIds = new Set([...previousViews.keys(), ...nextViews.keys()]);
		this.views = nextViews;
		for (const id of changedIds) {
			if (!sameView(previousViews.get(id), nextViews.get(id))) {
				this.invalidators.get(id)?.();
			}
		}
	}
}
