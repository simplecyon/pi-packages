import path from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type BaseSnapshot,
	type MemoryFile,
	extractBashPaths,
	findNearestScopeMemory,
	hashText,
	isSamePath,
	loadBaseSnapshot,
	looksMutatingBash,
	resolveToolPath,
} from "./memory.ts";

const DISABLE_ENV = "PI_NO_MEMORY_INJECTION";
const AGENT_DIR_ENV = "PI_MEMORY_AGENT_DIR";
const CUSTOM_TYPE = "cyon-scope-memory";
const MEMORY_READ_ENTRY = "memory-read-event";
const BASE_EVENT = "memory-injection:base-loaded";
const CAPABILITY_AVAILABLE = "cyon:memory:available";
const CAPABILITY_DISCOVER = "cyon:memory:discover";

interface ScopeMessageDetails {
	scopeDir: string;
	memoryPath: string;
	memoryHash: string;
	epoch: number;
}

interface ScopeState extends ScopeMessageDetails {
	status: "pending" | "resident";
	readyAtTurn: number;
}

interface MemoryReadEntry {
	signature: string;
	labels: string[];
	recordedAt: string;
}

function formatScopeMessage(memory: MemoryFile, cwd: string): string {
	const scope = path.relative(cwd, memory.scopeDir) || ".";
	const truncation = memory.truncated
		? "\nNote: this memory exceeded the package budget and was middle-truncated."
		: "";
	return [
		`<scope_memory scope="${scope}" path="${memory.path}">`,
		"The following project memory is authoritative for this scope.",
		"Read and follow it before retrying the blocked mutation.",
		truncation,
		"",
		memory.content,
		"</scope_memory>",
	].join("\n");
}

function formatBase(snapshot: BaseSnapshot): string {
	return snapshot.files
		.map((file) => {
			const truncation = file.truncated ? ' truncated="middle"' : "";
			return `<file path="${file.path}" scope="${file.scopeDir}"${truncation}>\n${file.content}\n</file>`;
		})
		.join("\n");
}

function detailsFromMessage(message: unknown): ScopeMessageDetails | null {
	if (!message || typeof message !== "object") return null;
	const candidate = message as {
		role?: unknown;
		customType?: unknown;
		details?: Partial<ScopeMessageDetails>;
	};
	if (candidate.role !== "custom" || candidate.customType !== CUSTOM_TYPE) return null;
	const details = candidate.details;
	if (
		!details ||
		typeof details.scopeDir !== "string" ||
		typeof details.memoryPath !== "string" ||
		typeof details.memoryHash !== "string"
	) {
		return null;
	}
	return {
		scopeDir: details.scopeDir,
		memoryPath: details.memoryPath,
		memoryHash: details.memoryHash,
		epoch: typeof details.epoch === "number" ? details.epoch : 0,
	};
}

function mutationTargets(event: ToolCallEvent, cwd: string): string[] | null {
	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		const target = resolveToolPath(event.input.path, cwd);
		return target ? [target] : [];
	}
	if (!isToolCallEventType("bash", event) || !looksMutatingBash(event.input.command)) {
		return null;
	}
	const extracted = extractBashPaths(event.input.command, cwd);
	return extracted.length > 0 ? extracted : [path.resolve(cwd)];
}

function readTargets(event: ToolResultEvent, cwd: string): string[] {
	const input = event.input;
	if (
		event.toolName === "read" ||
		event.toolName === "grep" ||
		event.toolName === "find" ||
		event.toolName === "ls"
	) {
		const values = [input.path, input.cwd];
		return values
			.map((value) => resolveToolPath(value, cwd))
			.filter((value): value is string => value !== null);
	}
	if (event.toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (looksMutatingBash(command)) return [];
		return extractBashPaths(command, cwd);
	}
	return [];
}

export default function memoryExtension(pi: ExtensionAPI): void {
	let snapshot: BaseSnapshot = {
		files: [],
		projectRoot: process.cwd(),
		signature: hashText(""),
	};
	let currentTurn = 0;
	let epoch = 0;
	let enabled = process.env[DISABLE_ENV] !== "1";
	const scopes = new Map<string, ScopeState>();
	const announcedBaseSignatures = new Set<string>();

	const getConfiguredAgentDir = () => process.env[AGENT_DIR_ENV] || getAgentDir();

	function baseMemoryLabels(): string[] {
		const agentDir = getConfiguredAgentDir();
		return snapshot.files.map((file) => {
			if (isSamePath(file.scopeDir, agentDir)) return "全局";
			const relative = path.relative(snapshot.projectRoot, file.scopeDir);
			return relative || path.basename(snapshot.projectRoot);
		});
	}

	function rebuildReadAnnouncements(ctx: ExtensionContext): void {
		announcedBaseSignatures.clear();
		const manager = ctx.sessionManager as unknown as {
			getBranch?: () => unknown[];
		};
		for (const candidate of manager.getBranch?.() ?? []) {
			const entry = candidate as {
				type?: string;
				customType?: string;
				data?: Partial<MemoryReadEntry>;
			};
			if (
				entry.type === "custom" &&
				entry.customType === MEMORY_READ_ENTRY &&
				typeof entry.data?.signature === "string"
			) {
				announcedBaseSignatures.add(entry.data.signature);
			}
		}
	}

	function announceBaseRead(): void {
		if (announcedBaseSignatures.has(snapshot.signature)) return;
		pi.appendEntry<MemoryReadEntry>(MEMORY_READ_ENTRY, {
			signature: snapshot.signature,
			labels: baseMemoryLabels(),
			recordedAt: new Date().toISOString(),
		});
		announcedBaseSignatures.add(snapshot.signature);
	}

	function emitBase(): void {
		const payload = {
			signature: snapshot.signature,
			files: snapshot.files.map((file) => ({ ...file })),
		};
		pi.events.emit(BASE_EVENT, payload);
		pi.events.emit(CAPABILITY_AVAILABLE, {
			owner: "@simplecyon/pi-memory",
			protocolVersion: 1,
			baseEvent: BASE_EVENT,
			scopeMessageType: CUSTOM_TYPE,
		});
	}

	function refreshBase(cwd: string): boolean {
		const next = loadBaseSnapshot(cwd, getConfiguredAgentDir());
		const changed = next.signature !== snapshot.signature;
		snapshot = next;
		emitBase();
		return changed;
	}

	function rebuildResidency(ctx: ExtensionContext): void {
		scopes.clear();
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const details = detailsFromMessage(message);
			if (!details) continue;
			const current = findNearestScopeMemory(
				details.memoryPath,
				snapshot.projectRoot,
			);
			if (!current || current.hash !== details.memoryHash) continue;
			scopes.set(details.scopeDir, {
				...details,
				epoch,
				status: "resident",
				readyAtTurn: currentTurn,
			});
		}
	}

	function baseContains(memory: MemoryFile): boolean {
		return snapshot.files.some(
			(file) => file.scopeDir === memory.scopeDir && file.hash === memory.hash,
		);
	}

	function isResident(memory: MemoryFile): boolean {
		if (baseContains(memory)) return true;
		const state = scopes.get(memory.scopeDir);
		if (!state || state.memoryHash !== memory.hash || state.epoch !== epoch) {
			return false;
		}
		if (state.status === "pending" && currentTurn >= state.readyAtTurn) {
			state.status = "resident";
		}
		return state.status === "resident";
	}

	function queueScope(memory: MemoryFile, ctx: ExtensionContext): boolean {
		const existing = scopes.get(memory.scopeDir);
		if (
			existing?.status === "pending" &&
			existing.memoryHash === memory.hash &&
			existing.epoch === epoch
		) {
			return true;
		}
		try {
			const details: ScopeMessageDetails = {
				scopeDir: memory.scopeDir,
				memoryPath: memory.path,
				memoryHash: memory.hash,
				epoch,
			};
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: formatScopeMessage(memory, ctx.cwd),
					display: true,
					details,
				},
				{ deliverAs: "steer" },
			);
			scopes.set(memory.scopeDir, {
				...details,
				status: "pending",
				readyAtTurn: currentTurn + 1,
			});
			return true;
		} catch {
			return false;
		}
	}

	function scopeForTarget(target: string): MemoryFile | null {
		return findNearestScopeMemory(target, snapshot.projectRoot);
	}

	pi.events.on(CAPABILITY_DISCOVER, emitBase);

	pi.registerEntryRenderer<MemoryReadEntry>(
		MEMORY_READ_ENTRY,
		(entry, { expanded }, theme) => {
			const data = entry.data;
			const labels = data?.labels ?? [];
			const subject =
				labels.length === 1 ? labels[0] : `${labels.length} 份`;
			const object =
				labels.length === 1
					? `${theme.fg("accent", theme.bold(subject ?? "记忆"))} ${theme.fg("muted", "记忆")}`
					: `${theme.fg("accent", theme.bold(subject))}${theme.fg("muted", "记忆")}`;
			const line = [
				theme.fg("accent", "✦"),
				theme.fg("muted", "读取了"),
				object,
			].join(" ");
			const details =
				expanded && data
					? `\n${theme.fg("dim", `${labels.join(" · ")} · ${data.recordedAt}`)}`
					: "";
			const text = line + details;
			return {
				render: () => text.split("\n"),
				invalidate: () => {},
			};
		},
	);

	pi.registerMessageRenderer<ScopeMessageDetails>(
		CUSTOM_TYPE,
		(message, { expanded }, theme) => {
			const scope = message.details?.scopeDir
				? path.basename(message.details.scopeDir)
				: "scope";
			const header = [
				theme.fg("accent", "✦"),
				theme.fg("muted", "读取了"),
				theme.fg("accent", theme.bold(scope)),
				theme.fg("muted", "记忆"),
			].join(" ");
			if (!expanded) return new Text(header, 0, 0);
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((block) => ("text" in block ? block.text : ""))
							.join("\n");
			return new Text(`${header}\n${theme.fg("toolOutput", content)}`, 0, 0);
		},
	);

	pi.registerCommand("memory", {
		description: "Show or refresh scoped MEMORY.md injection state",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "off") {
				enabled = false;
				ctx.ui.notify("Memory injection disabled for this session.", "info");
				return;
			}
			if (action === "on") {
				enabled = true;
				refreshBase(ctx.cwd);
				rebuildResidency(ctx);
				ctx.ui.notify("Memory injection enabled for this session.", "info");
				return;
			}
			if (action === "refresh") {
				const changed = refreshBase(ctx.cwd);
				epoch += 1;
				rebuildResidency(ctx);
				ctx.ui.notify(
					`Memory refreshed${changed ? " (base changed)" : ""}: ${snapshot.files.length} base, ${scopes.size} resident scope(s).`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`Memory: ${enabled ? "on" : "off"} · ${snapshot.files.length} base · ${scopes.size} resident/pending scope(s) · epoch ${epoch}`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event: SessionStartEvent, ctx) => {
		currentTurn = 0;
		epoch = 0;
		scopes.clear();
		rebuildReadAnnouncements(ctx);
		if (!enabled) return;
		refreshBase(ctx.cwd);
		rebuildResidency(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!enabled) return;
		epoch += 1;
		rebuildReadAnnouncements(ctx);
		refreshBase(ctx.cwd);
		rebuildResidency(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!enabled) return;
		epoch += 1;
		rebuildResidency(ctx);
	});

	pi.on("turn_start", (_event: TurnStartEvent) => {
		currentTurn += 1;
		for (const state of scopes.values()) {
			if (
				state.status === "pending" &&
				state.epoch === epoch &&
				currentTurn >= state.readyAtTurn
			) {
				state.status = "resident";
			}
		}
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
		if (!enabled) return;
		refreshBase(ctx.cwd);
		if (snapshot.files.length === 0) return;
		announceBaseRead();
		return {
			systemPrompt: `${event.systemPrompt}\n\n<project_memory>\n${formatBase(snapshot)}\n</project_memory>\n`,
		};
	});

	pi.on(
		"tool_call",
		(event: ToolCallEvent, ctx): ToolCallEventResult | undefined => {
			if (!enabled) return;
			const targets = mutationTargets(event, ctx.cwd);
			if (targets === null) return;

			const unread = new Map<string, MemoryFile>();
			for (const target of targets) {
				const memory = scopeForTarget(target);
				if (!memory || isResident(memory)) continue;
				unread.set(memory.scopeDir, memory);
			}
			if (unread.size === 0) return;

			const failed: string[] = [];
			for (const memory of unread.values()) {
				if (!queueScope(memory, ctx)) failed.push(memory.path);
			}
			if (failed.length > 0) {
				return {
					block: true,
					reason: `Mutation blocked because scoped memory could not be delivered: ${failed.join(", ")}`,
				};
			}
			const scopesText = [...unread.values()]
				.map((memory) => `"${path.relative(ctx.cwd, memory.scopeDir) || "."}"`)
				.join(", ");
			return {
				block: true,
				reason: `Mutation blocked until scoped memory for ${scopesText} is read. Retry this operation in the next turn.`,
			};
		},
	);

	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (!enabled || event.isError) return;
		for (const target of readTargets(event, ctx.cwd)) {
			const memory = scopeForTarget(target);
			if (!memory || isResident(memory)) continue;
			if (isSamePath(target, memory.path)) {
				scopes.set(memory.scopeDir, {
					scopeDir: memory.scopeDir,
					memoryPath: memory.path,
					memoryHash: memory.hash,
					epoch,
					status: "resident",
					readyAtTurn: currentTurn,
				});
				continue;
			}
			queueScope(memory, ctx);
		}
	});
}

export {
	extractBashPaths,
	findNearestScopeMemory,
	findProjectRoot,
	hashText,
	loadBaseSnapshot,
	loadMemoryFromDir,
	looksMutatingBash,
	truncateMemory,
} from "./memory.ts";
