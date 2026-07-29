import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import memoryExtension from "../src/index.ts";

interface SentMessage {
	message: {
		customType: string;
		content: string;
		details: Record<string, unknown>;
	};
	options: { deliverAs: string };
}

function createHarness(activeMessages: unknown[]) {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const commands = new Map<string, (...args: any[]) => unknown>();
	const sent: SentMessage[] = [];
	const emitted: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const entryRenderers = new Map<string, (...args: any[]) => unknown>();
	const messageRenderers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
			commands.set(name, command.handler);
		},
		registerEntryRenderer(customType: string, renderer: (...args: any[]) => unknown) {
			entryRenderers.set(customType, renderer);
		},
		registerMessageRenderer(customType: string, renderer: (...args: any[]) => unknown) {
			messageRenderers.set(customType, renderer);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
			sent.push({ message, options });
		},
		events: {
			on() {
				return () => {};
			},
			emit(name: string) {
				emitted.push(name);
			},
		},
	} as unknown as ExtensionAPI;
	memoryExtension(pi);
	return {
		handlers,
		commands,
		sent,
		emitted,
		entries,
		entryRenderers,
		messageRenderers,
	};
}

async function fire(
	handlers: Map<string, Array<(...args: any[]) => unknown>>,
	name: string,
	event: unknown,
	ctx: ExtensionContext,
) {
	let result: unknown;
	for (const handler of handlers.get(name) ?? []) {
		const next = await handler(event, ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

test("blocks each scope once, deduplicates same-turn calls, and allows directory switching", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-extension-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-agent-"));
	const oldAgentDir = process.env.PI_MEMORY_AGENT_DIR;
	process.env.PI_MEMORY_AGENT_DIR = agent;
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(root, "MEMORY.md"), "root memory");
		for (const scope of ["A", "B", "C", "D"]) {
			fs.mkdirSync(path.join(root, scope));
			fs.writeFileSync(path.join(root, scope, "MEMORY.md"), `${scope} memory`);
		}

		const activeMessages: unknown[] = [];
		const harness = createHarness(activeMessages);
		const ctx = {
			cwd: root,
			sessionManager: {
				buildContextEntries: () =>
					activeMessages.map((message, index) => ({
						type: "message",
						id: `message-${index}`,
						message,
					})),
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;

		await fire(harness.handlers, "session_start", { reason: "startup" }, ctx);
		const before = (await fire(
			harness.handlers,
			"before_agent_start",
			{ systemPrompt: "SYSTEM" },
			ctx,
		)) as { systemPrompt: string };
		assert.match(before.systemPrompt, /root memory/);

		await fire(harness.handlers, "turn_start", { turnIndex: 0 }, ctx);
		const editA = {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "a1",
			input: { path: "A/file.md", oldText: "x", newText: "y" },
		} as unknown as ToolCallEvent;
		const firstA = (await fire(harness.handlers, "tool_call", editA, ctx)) as {
			block: boolean;
		};
		assert.equal(firstA.block, true);
		assert.equal(harness.sent.length, 1);

		const duplicateA = (await fire(harness.handlers, "tool_call", editA, ctx)) as {
			block: boolean;
		};
		assert.equal(duplicateA.block, true);
		assert.equal(harness.sent.length, 1);

		await fire(harness.handlers, "turn_start", { turnIndex: 1 }, ctx);
		assert.equal(await fire(harness.handlers, "tool_call", editA, ctx), undefined);

		const editB = {
			...editA,
			toolCallId: "b1",
			input: { ...editA.input, path: "B/file.md" },
		} as unknown as ToolCallEvent;
		const firstB = (await fire(harness.handlers, "tool_call", editB, ctx)) as {
			block: boolean;
		};
		assert.equal(firstB.block, true);
		assert.equal(harness.sent.length, 2);

		await fire(harness.handlers, "turn_start", { turnIndex: 2 }, ctx);
		assert.equal(await fire(harness.handlers, "tool_call", editB, ctx), undefined);
		assert.equal(await fire(harness.handlers, "tool_call", editA, ctx), undefined);

		fs.writeFileSync(path.join(root, "A", "MEMORY.md"), "A memory changed");
		const staleA = (await fire(harness.handlers, "tool_call", editA, ctx)) as {
			block: boolean;
		};
		assert.equal(staleA.block, true);
		assert.equal(harness.sent.length, 3);

		const crossScopeBash = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "cross-scope",
			input: { command: "touch A/new.md B/new.md" },
		} as unknown as ToolCallEvent;
		const crossScope = (await fire(
			harness.handlers,
			"tool_call",
			crossScopeBash,
			ctx,
		)) as { block: boolean };
		assert.equal(crossScope.block, true);
		// A was already pending with its changed hash; B remained resident.
		assert.equal(harness.sent.length, 3);

		const twoUnreadScopes = {
			...crossScopeBash,
			toolCallId: "two-unread-scopes",
			input: { command: "touch C/new.md D/new.md" },
		} as unknown as ToolCallEvent;
		const twoUnread = (await fire(
			harness.handlers,
			"tool_call",
			twoUnreadScopes,
			ctx,
		)) as { block: boolean };
		assert.equal(twoUnread.block, true);
		assert.equal(harness.sent.length, 5);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_MEMORY_AGENT_DIR;
		else process.env.PI_MEMORY_AGENT_DIR = oldAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("read disclosure is reused by later mutation and active context survives compaction", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-read-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-agent-"));
	const oldAgentDir = process.env.PI_MEMORY_AGENT_DIR;
	process.env.PI_MEMORY_AGENT_DIR = agent;
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(root, "MEMORY.md"), "root");
		fs.mkdirSync(path.join(root, "A"));
		fs.writeFileSync(path.join(root, "A", "MEMORY.md"), "scope A");
		fs.writeFileSync(path.join(root, "A", "note.md"), "note");

		const activeMessages: unknown[] = [];
		const harness = createHarness(activeMessages);
		const ctx = {
			cwd: root,
			sessionManager: {
				buildContextEntries: () =>
					activeMessages.map((message, index) => ({
						type: "message",
						id: `message-${index}`,
						message,
					})),
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		await fire(harness.handlers, "session_start", { reason: "startup" }, ctx);
		await fire(harness.handlers, "turn_start", { turnIndex: 0 }, ctx);

		await fire(
			harness.handlers,
			"tool_result",
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "read-a",
				input: { path: "A/note.md" },
				content: [{ type: "text", text: "note" }],
				isError: false,
			} as unknown as ToolResultEvent,
			ctx,
		);
		assert.equal(harness.sent.length, 1);

		const sent = harness.sent[0].message;
		activeMessages.push({
			role: "custom",
			customType: sent.customType,
			content: sent.content,
			details: sent.details,
		});
		await fire(harness.handlers, "turn_start", { turnIndex: 1 }, ctx);

		const edit = {
			type: "tool_call",
			toolName: "edit",
			toolCallId: "edit-a",
			input: { path: "A/note.md", oldText: "note", newText: "changed" },
		} as unknown as ToolCallEvent;
		assert.equal(await fire(harness.handlers, "tool_call", edit, ctx), undefined);

		await fire(
			harness.handlers,
			"session_compact",
			{ reason: "manual", fromExtension: false },
			ctx,
		);
		assert.equal(await fire(harness.handlers, "tool_call", edit, ctx), undefined);

		activeMessages.length = 0;
		await fire(
			harness.handlers,
			"session_compact",
			{ reason: "manual", fromExtension: false },
			ctx,
		);
		const afterRemoval = (await fire(
			harness.handlers,
			"tool_call",
			edit,
			ctx,
		)) as { block: boolean };
		assert.equal(afterRemoval.block, true);
		assert.equal(harness.sent.length, 2);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_MEMORY_AGENT_DIR;
		else process.env.PI_MEMORY_AGENT_DIR = oldAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("renders base and scoped memory reads as independent TUI events", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-render-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-agent-"));
	const oldAgentDir = process.env.PI_MEMORY_AGENT_DIR;
	process.env.PI_MEMORY_AGENT_DIR = agent;
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(root, "MEMORY.md"), "root memory");
		fs.writeFileSync(path.join(agent, "MEMORY.md"), "global memory");

		const harness = createHarness([]);
		const ctx = {
			cwd: root,
			sessionManager: {
				buildContextEntries: () => [],
				getBranch: () => [],
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		await fire(harness.handlers, "session_start", { reason: "startup" }, ctx);
		await fire(
			harness.handlers,
			"before_agent_start",
			{ systemPrompt: "SYSTEM" },
			ctx,
		);
		await fire(
			harness.handlers,
			"before_agent_start",
			{ systemPrompt: "SYSTEM" },
			ctx,
		);

		assert.equal(harness.entries.length, 1);
		assert.equal(harness.entries[0]?.customType, "memory-read-event");
		const entryRenderer = harness.entryRenderers.get("memory-read-event");
		assert.ok(entryRenderer);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const baseComponent = entryRenderer(
			{ data: harness.entries[0]?.data },
			{ expanded: false },
			theme,
		) as { render(width: number): string[] };
		assert.deepEqual(baseComponent.render(80), ["✦ 读取了 2 份记忆"]);

		const resumedHarness = createHarness([]);
		const resumedCtx = {
			...ctx,
			sessionManager: {
				buildContextEntries: () => [],
				getBranch: () => [
					{
						type: "custom",
						customType: "memory-read-event",
						data: harness.entries[0]?.data,
					},
				],
			},
		} as unknown as ExtensionContext;
		await fire(
			resumedHarness.handlers,
			"session_start",
			{ reason: "resume" },
			resumedCtx,
		);
		await fire(
			resumedHarness.handlers,
			"before_agent_start",
			{ systemPrompt: "SYSTEM" },
			resumedCtx,
		);
		assert.equal(resumedHarness.entries.length, 0);

		const scopeRenderer = harness.messageRenderers.get("cyon-scope-memory");
		assert.ok(scopeRenderer);
		const scopeComponent = scopeRenderer(
			{
				content: "scope memory",
				details: { scopeDir: path.join(root, "Projects", "pi") },
			},
			{ expanded: false },
			theme,
		) as { render(width: number): string[] };
		assert.deepEqual(
			scopeComponent.render(80).map((line) => line.trimEnd()),
			["✦ 读取了 pi 记忆"],
		);
	} finally {
		if (oldAgentDir === undefined) delete process.env.PI_MEMORY_AGENT_DIR;
		else process.env.PI_MEMORY_AGENT_DIR = oldAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});
