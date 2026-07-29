import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runContextCode } from "./executor.ts";
import {
	indexContent,
	indexPath,
	indexUrl,
} from "./indexer.ts";
import { migrateContextMode } from "./migrate.ts";
import { searchRecords } from "./search.ts";
import {
	appendRecords,
	createRecord,
	projectStorePath,
	purgeProjectStore,
	readStore,
	storeStats,
} from "./storage.ts";
import type {
	ContextSearchHit,
} from "./types.ts";

const SAFE_CAPABILITY_DISCOVER = "simplecyon:safe-operation:discover";
const SAFE_CAPABILITY_AVAILABLE = "simplecyon:safe-operation:available";
const SAFE_REDACT_REQUEST = "simplecyon:safe-operation:redact";
const COMPACT_SEARCH_REQUEST = "simplecyon:context-engine:compact-search";
const CHECKPOINT_OWNER = "context-compact-cyon";
const SEARCH_TOOL = "context_search";
const RUN_TOOL = "context_run";
const INDEX_TOOL = "context_index";

const ContextRunSchema = Type.Object({
	language: Type.Union([
		Type.Literal("javascript"),
		Type.Literal("python"),
	], {
		description: "Child-process language used for the analysis",
	}),
	code: Type.String({
		minLength: 1,
		maxLength: 100_000,
		description:
			"Analysis code. Print only the derived answer; raw file bytes should stay inside the child process.",
	}),
	files: Type.Optional(Type.Array(
		Type.String({ minLength: 1, maxLength: 1_000 }),
		{
			maxItems: 20,
			description:
				"Optional project-local files loaded into FILES; the first is also FILE_CONTENT.",
		},
	)),
	timeoutSeconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 120,
		default: 30,
	})),
}, { additionalProperties: false });

const ContextIndexSchema = Type.Object({
	source: Type.String({
		minLength: 1,
		maxLength: 240,
		description: "Stable label used to replace and later scope this source",
	}),
	content: Type.Optional(Type.String({
		minLength: 1,
		description: "Text to index without echoing it back",
	})),
	path: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 2_000,
		description: "Project-local text file or directory to index",
	})),
	url: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 4_000,
		description: "Public HTTP(S) text resource to fetch and index",
	})),
}, { additionalProperties: false });

const ContextSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: 500,
		description: "Specific phrase or technical terms to retrieve",
	}),
	source: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 240,
		description: "Optional exact source label",
	})),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 20,
		default: 5,
	})),
}, { additionalProperties: false });

interface CompactSearchRequest {
	sessionRef: string;
	query: string;
	limit: number;
	searches: Array<Promise<Array<{
		segmentId: string;
		createdAt: string;
		role: string;
		text: string;
		score: number;
	}>>>;
}

function isSafeCapability(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const capability = value as {
		owner?: unknown;
		protocolVersion?: unknown;
		redactsToolResults?: unknown;
	};
	return (
		capability.owner === "@simplecyon/pi-safe-operation" &&
		capability.protocolVersion === 1 &&
		capability.redactsToolResults === true
	);
}

function sessionRef(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	ephemeralId: string,
): string {
	return ctx.sessionManager.getSessionFile() ??
		`ephemeral:${ctx.cwd}:${ephemeralId}`;
}

function sessionSource(ref: string): string {
	return `session:${createHash("sha256").update(ref).digest("hex").slice(0, 16)}`;
}

function contentText(content: readonly unknown[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as { type?: unknown; text?: unknown };
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		}
	}
	return parts.join("\n");
}

function bounded(value: string, maxChars: number): string {
	const normalized = value.trim();
	if (normalized.length <= maxChars) return normalized;
	const head = normalized.slice(0, Math.floor(maxChars * 0.65));
	const tail = normalized.slice(-Math.floor(maxChars * 0.35));
	return `${head}\n[… ${normalized.length - maxChars} characters omitted …]\n${tail}`;
}

function decisionLike(prompt: string): boolean {
	return /(决定|改为|选择|必须|不要|不能|默认|除非|后续|记住|decid|must\b|do not\b|never\b|default\b|instead\b)/iu
		.test(prompt);
}

function relativeProjectPath(cwd: string, value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const target = resolve(cwd, value);
	const rel = relative(resolve(cwd), target);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel || ".";
}

function classifyGit(command: string): string | null {
	const match = command.match(
		/\bgit(?:\s+-C\s+\S+)?\s+(status|diff|log|add|commit|fetch|pull|push|rebase|merge|checkout|switch|branch|stash|tag|worktree)\b/i,
	);
	return match ? `git ${match[1].toLocaleLowerCase()}` : null;
}

function formatSearchHits(hits: readonly ContextSearchHit[]): string {
	if (hits.length === 0) return "No matching context records.";
	const blocks: string[] = [];
	let remaining = 12_000;
	for (const [index, hit] of hits.entries()) {
		const block = [
			`[${index + 1}] ${hit.source} · ${hit.title} · ${hit.kind} · score ${hit.score.toFixed(2)}`,
			hit.snippet,
		].join("\n");
		if (block.length > remaining) break;
		blocks.push(block);
		remaining -= block.length + 2;
	}
	return blocks.join("\n\n");
}

function resolveCommandContext(
	first: unknown,
	second: unknown,
): ExtensionContext | undefined {
	for (const value of [second, first]) {
		if (
			value &&
			typeof value === "object" &&
			"cwd" in value &&
			"ui" in value
		) {
			return value as ExtensionContext;
		}
	}
	return undefined;
}

export default function contextEngineExtension(pi: ExtensionAPI): void {
	let safetyReady = false;
	let ephemeralId = randomUUID();
	let currentSessionRef = "";
	let currentProjectDir = process.cwd();
	let recordCount = 0;

	function sanitizeText(value: string): string {
		if (!safetyReady) {
			throw new Error("safe-operation capability unavailable");
		}
		const request = {
			value: {
				content: [{ type: "text" as const, text: value }],
			},
			phase: "final" as const,
		};
		pi.events.emit(SAFE_REDACT_REQUEST, request);
		const content = request.value?.content;
		if (
			!Array.isArray(content) ||
			content.length !== 1 ||
			content[0]?.type !== "text" ||
			typeof content[0].text !== "string"
		) {
			throw new Error("safe-operation returned an invalid redaction payload");
		}
		return content[0].text;
	}

	function hasOwnedCompaction(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "compaction") return false;
			const details = entry.details as { owner?: unknown } | undefined;
			return details?.owner === CHECKPOINT_OWNER;
		});
	}

	function setSearchActive(active: boolean): void {
		const current = pi.getActiveTools();
		const next = active
			? [...new Set([...current, SEARCH_TOOL])]
			: current.filter((name) => name !== SEARCH_TOOL);
		if (
			next.length !== current.length ||
			next.some((name, index) => name !== current[index])
		) {
			pi.setActiveTools(next);
		}
	}

	async function refreshRecordCount(ctx?: ExtensionContext): Promise<void> {
		const store = await readStore(currentProjectDir);
		recordCount = store.records.length;
		setSearchActive(recordCount > 0 || Boolean(ctx && hasOwnedCompaction(ctx)));
	}

	async function appendSessionRecord(input: {
		title: string;
		content: string;
		category: string;
		eventType: string;
		path?: string;
	}): Promise<void> {
		if (!safetyReady || !currentSessionRef || !input.content.trim()) return;
		const record = createRecord({
			kind: "session",
			source: sessionSource(currentSessionRef),
			title: input.title,
			content: sanitizeText(bounded(input.content, 6_000)),
			sessionRef: currentSessionRef,
			category: input.category,
			eventType: input.eventType,
			...(input.path ? { path: input.path } : {}),
		});
		const added = await appendRecords(currentProjectDir, [record]);
		if (added > 0) {
			recordCount += added;
			setSearchActive(true);
		}
	}

	pi.events.on(SAFE_CAPABILITY_AVAILABLE, (data) => {
		if (isSafeCapability(data)) safetyReady = true;
	});
	pi.events.emit(SAFE_CAPABILITY_DISCOVER, {
		owner: "@simplecyon/pi-context-engine",
		protocolVersion: 1,
	});

	pi.registerTool({
		name: RUN_TOOL,
		label: "Run Context Analysis",
		description:
			"Run JavaScript or Python in a child process for data-heavy analysis. Optional project files are loaded into FILES/FILE_CONTENT. Print only the derived answer so raw bytes stay outside model context.",
		parameters: ContextRunSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!safetyReady) {
				throw new Error("context_run disabled: safe-operation is unavailable");
			}
			const result = await runContextCode(pi, ctx, params, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: {
					language: result.language,
					fileCount: result.fileCount,
					exitCode: result.exitCode,
					killed: result.killed,
				},
			};
		},
	});

	pi.registerTool({
		name: INDEX_TOOL,
		label: "Index Context",
		description:
			"Persist redacted text, a project-local file/directory, or a public HTTP(S) text resource under one stable source label. Raw indexed content is not echoed; use context_search afterward.",
		parameters: ContextIndexSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!safetyReady) {
				throw new Error("context_index disabled: safe-operation is unavailable");
			}
			const choices = [
				typeof params.content === "string",
				typeof params.path === "string",
				typeof params.url === "string",
			].filter(Boolean).length;
			if (choices !== 1) {
				throw new Error("context_index requires exactly one of content, path, or url");
			}
			let records = 0;
			let detail = "";
			if (params.content) {
				records = await indexContent({
					projectDir: ctx.cwd,
					source: params.source,
					content: params.content,
					sanitize: sanitizeText,
				});
				detail = "supplied text";
			} else if (params.path) {
				records = await indexPath({
					projectDir: ctx.cwd,
					source: params.source,
					path: params.path,
					sanitize: sanitizeText,
				});
				detail = params.path;
			} else {
				const result = await indexUrl({
					projectDir: ctx.cwd,
					source: params.source,
					url: params.url!,
					sanitize: sanitizeText,
					signal,
				});
				records = result.records;
				detail = result.finalUrl;
			}
			currentProjectDir = ctx.cwd;
			await refreshRecordCount(ctx);
			return {
				content: [{
					type: "text" as const,
					text:
						`Indexed ${records} context record(s) from ${detail} as ${params.source}. ` +
						"Use context_search for focused retrieval.",
				}],
				details: { source: params.source, records },
			};
		},
	});

	pi.registerTool({
		name: SEARCH_TOOL,
		label: "Search Context",
		description:
			"Search persistent indexed documents, native session continuity records, migrated context-mode history, and compacted Pi history. Returns bounded ranked snippets.",
		parameters: ContextSearchSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "Context search cancelled." }],
					details: { hits: 0 },
				};
			}
			currentProjectDir = ctx.cwd;
			currentSessionRef = sessionRef(ctx, ephemeralId);
			const store = await readStore(ctx.cwd);
			const persistent = searchRecords(store.records, params.query, {
				limit: params.limit ?? 5,
				...(params.source ? { source: params.source } : {}),
			});
			const request: CompactSearchRequest = {
				sessionRef: currentSessionRef,
				query: params.query,
				limit: params.limit ?? 5,
				searches: [],
			};
			pi.events.emit(COMPACT_SEARCH_REQUEST, request);
			const compactHits = params.source && params.source !== "compact-history"
				? []
				: (await Promise.all(request.searches)).flat();
			const converted: ContextSearchHit[] = compactHits.map((hit) => ({
				id: hit.segmentId,
				kind: "session",
				source: "compact-history",
				title: hit.role,
				createdAt: hit.createdAt,
				score: hit.score,
				snippet: hit.text,
				category: "compaction",
				eventType: "compacted-message",
			}));
			const hits = [...persistent, ...converted]
				.sort((a, b) =>
					b.score - a.score ||
					b.createdAt.localeCompare(a.createdAt)
				)
				.slice(0, params.limit ?? 5);
			return {
				content: [{ type: "text" as const, text: formatSearchHits(hits) }],
				details: {
					hits: hits.length,
					persistentHits: persistent.length,
					compactHits: converted.length,
				},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ephemeralId = randomUUID();
		currentProjectDir = ctx.cwd;
		currentSessionRef = sessionRef(ctx, ephemeralId);
		await refreshRecordCount(ctx).catch(() => {
			recordCount = 0;
			setSearchActive(hasOwnedCompaction(ctx));
		});
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentProjectDir = ctx.cwd;
		currentSessionRef = sessionRef(ctx, ephemeralId);
		await refreshRecordCount(ctx).catch(() => {});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const prompt = String(event.prompt ?? "").trim();
			if (!prompt) return;
			currentProjectDir = ctx.cwd;
			currentSessionRef = sessionRef(ctx, ephemeralId);
			const decision = decisionLike(prompt);
			await appendSessionRecord({
				title: decision ? "user decision" : "user prompt",
				content: prompt,
				category: decision ? "decision" : "intent",
				eventType: decision ? "user-decision" : "user-prompt",
			});
		} catch {
			// Continuity capture is best-effort and must not block a model turn.
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			currentProjectDir = ctx.cwd;
			currentSessionRef = sessionRef(ctx, ephemeralId);
			const toolName = String(event.toolName ?? "").toLocaleLowerCase();
			if ([RUN_TOOL, INDEX_TOOL, SEARCH_TOOL, "artifact_read", "compact_search"].includes(toolName)) {
				return;
			}
			const input =
				event.input && typeof event.input === "object"
					? event.input as Record<string, unknown>
					: {};
			const path = relativeProjectPath(
				ctx.cwd,
				input.path ?? input.file_path ?? input.filePath,
			);
			if (path && ["read", "write", "edit"].includes(toolName)) {
				await appendSessionRecord({
					title: `${toolName} ${path}`,
					content: `${toolName} ${path}`,
					category: "file",
					eventType: `file-${toolName}`,
					path,
				});
			}
			if (toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				const git = classifyGit(command);
				if (git) {
					await appendSessionRecord({
						title: git,
						content: git,
						category: "git",
						eventType: git.replace(" ", "-"),
					});
				}
			}
			if (toolName === "update_tasks") {
				const text = bounded(contentText(event.content), 3_000);
				if (text) {
					await appendSessionRecord({
						title: "structured task update",
						content: text,
						category: "task",
						eventType: "task-update",
					});
				}
			}
			if (event.isError) {
				const text = bounded(contentText(event.content), 1_600);
				if (text) {
					await appendSessionRecord({
						title: `${toolName} error`,
						content: text,
						category: "error",
						eventType: "tool-error",
					});
				}
			}
		} catch {
			// Session ledger capture is best-effort.
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		if (hasOwnedCompaction(ctx)) setSearchActive(true);
	});

	pi.registerCommand("context-engine", {
		description: "Show Pi-native context-engine status",
		handler: async (first, second) => {
			const ctx = resolveCommandContext(first, second);
			const projectDir = ctx?.cwd ?? currentProjectDir;
			const store = await readStore(projectDir);
			const stats = storeStats(store);
			const text = [
				"Pi context engine",
				`safety: ${safetyReady ? "enabled" : "disabled"}`,
				`records: ${stats.records} (${stats.documents} documents · ${stats.sessionEvents} session · ${stats.legacyRecords} migrated)`,
				`sources: ${stats.sources}`,
				`characters outside model context: ${stats.characters}`,
				`search tool: ${pi.getActiveTools().includes(SEARCH_TOOL) ? "active" : "inactive"}`,
				`store: ${projectStorePath(projectDir)}`,
			].join("\n");
			ctx?.ui.notify(text, safetyReady ? "info" : "warning");
		},
	});

	pi.registerCommand("context-doctor", {
		description: "Diagnose Pi-native context replacement readiness",
		handler: async (first, second) => {
			const ctx = resolveCommandContext(first, second);
			const projectDir = ctx?.cwd ?? currentProjectDir;
			const store = await readStore(projectDir);
			const stats = storeStats(store);
			const userSettings = join(homedir(), ".pi", "agent", "settings.json");
			let legacyConfigured = false;
			try {
				const settings = await import("node:fs/promises")
					.then((fs) => fs.readFile(userSettings, "utf8"));
				legacyConfigured = settings.includes("context-mode");
			} catch {
				// Missing settings is a valid state.
			}
			const text = [
				"Pi context replacement doctor",
				`[${safetyReady ? "x" : " "}] safe-operation redaction`,
				`[${stats.records > 0 ? "x" : " "}] searchable native or migrated records`,
				`[${stats.migrations.includes("context-mode-pi-v2") ? "x" : " "}] legacy context-mode data migrated`,
				`[${legacyConfigured ? " " : "x"}] user settings no longer load context-mode`,
				`[${existsSync(join(homedir(), ".pi", "context-mode")) ? "x" : " "}] legacy source retained for rollback`,
				`store: ${projectStorePath(projectDir)}`,
			].join("\n");
			ctx?.ui.notify(text, safetyReady && !legacyConfigured ? "info" : "warning");
		},
	});

	pi.registerCommand("context-migrate", {
		description: "Copy matching legacy Pi context-mode data into the native store",
		handler: async (first, second) => {
			const ctx = resolveCommandContext(first, second);
			const projectDir = ctx?.cwd ?? currentProjectDir;
			if (!safetyReady) {
				ctx?.ui.notify(
					"Migration disabled: safe-operation redaction is unavailable.",
					"error",
				);
				return;
			}
			const result = await migrateContextMode({
				projectDir,
				sanitize: sanitizeText,
			});
			currentProjectDir = projectDir;
			await refreshRecordCount(ctx);
			ctx?.ui.notify(
				result.alreadyMigrated
					? `Legacy migration already completed · ${result.recordsImported} record(s)`
					: `Migrated ${result.recordsImported} record(s) from ${result.sourceFiles} legacy database(s) · skipped ${result.skippedDatabases}`,
				"info",
			);
		},
	});

	pi.registerCommand("context-purge", {
		description: "Delete this project's native context-engine store with --confirm",
		handler: async (args, maybeCtx) => {
			const ctx = resolveCommandContext(args, maybeCtx);
			const raw = typeof args === "string" ? args.trim() : "";
			if (raw !== "--confirm") {
				ctx?.ui.notify(
					"Usage: /context-purge --confirm (legacy context-mode databases are not deleted)",
					"warning",
				);
				return;
			}
			const projectDir = ctx?.cwd ?? currentProjectDir;
			await purgeProjectStore(projectDir);
			recordCount = 0;
			setSearchActive(Boolean(ctx && hasOwnedCompaction(ctx)));
			ctx?.ui.notify(
				"Deleted this project's native context-engine store. Legacy context-mode data was retained.",
				"info",
			);
		},
	});
}

export { chunkText } from "./chunk.ts";
export { runContextCode, resolveProjectFiles } from "./executor.ts";
export { assertPublicUrl, fetchTextResource, isPrivateAddress } from "./fetch.ts";
export { indexContent, indexPath, indexUrl, preparePathRecords } from "./indexer.ts";
export { migrateContextMode } from "./migrate.ts";
export { searchRecords } from "./search.ts";
export {
	appendRecords,
	canonicalProjectDir,
	contentHash,
	contextEngineRoot,
	createRecord,
	projectKey,
	projectStorePath,
	purgeProjectStore,
	readStore,
	replaceSource,
	replaceLegacyMigration,
	storeStats,
} from "./storage.ts";
