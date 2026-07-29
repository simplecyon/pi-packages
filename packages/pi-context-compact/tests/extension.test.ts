import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import contextCompactExtension from "../src/index.ts";
import { CAPABILITY_AVAILABLE, CAPABILITY_DISCOVER } from "../src/types.ts";

test("registers compact_search and provides custom compaction after durable storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-compact-extension-"));
	const previousRoot = process.env.PI_CONTEXT_COMPACT_DIR;
	process.env.PI_CONTEXT_COMPACT_DIR = root;

	const handlers = new Map<string, (...args: any[]) => unknown>();
	const tools: ToolDefinition[] = [];
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
				return () => {};
			},
			emit(channel: string, data: unknown) {
				emitted.push(channel);
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;

	try {
		contextCompactExtension(pi);
		assert.equal(tools[0]?.name, "compact_search");
		assert.ok(emitted.includes(CAPABILITY_AVAILABLE));

		pi.events.emit(CAPABILITY_DISCOVER, {});
		assert.equal(emitted.filter((channel) => channel === CAPABILITY_AVAILABLE).length, 2);

		const compact = handlers.get("session_before_compact");
		assert.ok(compact);
		const event = {
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			branchEntries: [],
			preparation: {
				firstKeptEntryId: "entry-2",
				tokensBefore: 42_000,
				isSplitTurn: false,
				messagesToSummarize: [
					{ role: "user", content: [{ type: "text", text: "必须保持 package-only" }] },
					{ role: "toolResult", content: [{ type: "text", text: "old exact result" }] },
				],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), edited: new Set(), created: new Set() },
				settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			},
		} as unknown as SessionBeforeCompactEvent;
		const ctx = {
			cwd: "/project",
			sessionManager: { getSessionFile: () => "/sessions/a.jsonl" },
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		} as unknown as ExtensionContext;
		const result = (await compact(event, ctx)) as {
			compaction: {
				summary: string;
				tokensBefore: number;
				details: { owner: string; messageCount: number };
			};
		};

		assert.match(result.compaction.summary, /continuation_checkpoint/);
		assert.equal(result.compaction.details.owner, "context-compact-cyon");
		assert.equal(result.compaction.details.messageCount, 2);

		const compacted = handlers.get("session_compact");
		assert.ok(compacted);
		await compacted(
			{
				type: "session_compact",
				fromExtension: true,
				reason: "manual",
				willRetry: false,
				compactionEntry: {
					tokensBefore: result.compaction.tokensBefore,
					details: result.compaction.details,
				},
			},
			ctx,
		);
		assert.deepEqual(notifications, [
			{ message: "Compacted 42k tokens · archived 2 messages", level: "info" },
		]);

		await compacted(
			{
				type: "session_compact",
				fromExtension: false,
				compactionEntry: { tokensBefore: 10_000, details: {} },
			},
			ctx,
		);
		assert.equal(notifications.length, 1);

		const searchTool = tools.find((tool) => tool.name === "compact_search");
		assert.ok(searchTool);
		const searchResult = await searchTool.execute(
			"call-1",
			{ query: "old exact result", limit: 5 },
			undefined,
			undefined,
			ctx,
		);
		assert.match((searchResult.content[0] as { text: string }).text, /old exact result/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_CONTEXT_COMPACT_DIR;
		else process.env.PI_CONTEXT_COMPACT_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("falls back to Pi compaction when durable storage fails", async () => {
	const previousRoot = process.env.PI_CONTEXT_COMPACT_DIR;
	process.env.PI_CONTEXT_COMPACT_DIR = "/dev/null/not-a-directory";
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, handler);
		},
		registerTool() {},
		events: { on: () => () => {}, emit() {} },
	} as unknown as ExtensionAPI;
	try {
		contextCompactExtension(pi);
		const result = await handlers.get("session_before_compact")?.(
			{
				reason: "manual",
				preparation: {
					firstKeptEntryId: "entry-2",
					tokensBefore: 42_000,
					isSplitTurn: false,
					messagesToSummarize: [{ role: "user", content: "keep this" }],
					turnPrefixMessages: [],
				},
			},
			{ cwd: "/project", sessionManager: { getSessionFile: () => "/sessions/a.jsonl" } },
		);
		assert.equal(result, undefined);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_CONTEXT_COMPACT_DIR;
		else process.env.PI_CONTEXT_COMPACT_DIR = previousRoot;
	}
});
