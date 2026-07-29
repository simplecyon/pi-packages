import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	estimateTextTokens,
} from "@simplecyon/pi-context-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import safeOperation from "../../pi-safe-operation/src/index.ts";
import contextArtifactsExtension from "../src/index.ts";
import { listArtifacts, readArtifact } from "../src/storage.ts";

test("replay: safe-operation redacts before artifact persistence and preview cuts visible tokens", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-artifacts-replay-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousDir = process.env.PI_CONTEXT_ARTIFACTS_DIR;
	const previousHard = process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
	const previousVisible = process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
	process.env.PI_CONTEXT_ARTIFACTS_DIR = root;
	process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = "4000";
	process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = "500";
	t.after(() => {
		if (previousDir === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_DIR;
		else process.env.PI_CONTEXT_ARTIFACTS_DIR = previousDir;
		if (previousHard === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = previousHard;
		if (previousVisible === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = previousVisible;
	});

	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	let activeTools: string[] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool: ToolDefinition) {
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		registerCommand() {},
		appendEntry() {},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const list = bus.get(name) ?? [];
				list.push(handler);
				bus.set(name, list);
				return () => {};
			},
			emit(name: string, data: unknown) {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
		async exec() {
			return { code: 0, stdout: "", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
		sessionManager: {
			getSessionFile: () => "/sessions/replay.jsonl",
			getSessionId: () => "replay",
			getBranch: () => [],
		},
		ui: {
			confirm: async () => false,
			input: async () => undefined,
			notify() {},
		},
	} as unknown as ExtensionContext;

	safeOperation(pi);
	contextArtifactsExtension(pi);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}

	const secret = "sk-replaysecret1234567890ABCDEFG";
	const originalText =
		`API_KEY=${secret}\nBEGIN\n` +
		"large safe payload line\n".repeat(5000) +
		"END";
	let event: any = {
		type: "tool_result",
		toolName: "read",
		toolCallId: "replay-read",
		input: { path: "fixture.txt" },
		content: [{ type: "text", text: originalText }],
		details: undefined,
		isError: false,
	};
	for (const handler of handlers.get("tool_result") ?? []) {
		const result = await handler(event, ctx) as any;
		if (result) event = { ...event, ...result };
	}

	const visible = event.content[0].text as string;
	assert.doesNotMatch(visible, new RegExp(secret));
	assert.match(visible, /Large tool result archived as/);
	assert.ok(estimateTextTokens(visible) < estimateTextTokens(originalText) * 0.25);

	const [artifact] = await listArtifacts("/sessions/replay.jsonl");
	assert.ok(artifact);
	const record = await readArtifact("/sessions/replay.jsonl", artifact.id);
	const stored = record?.content.map((block) => block.text).join("\n") ?? "";
	assert.doesNotMatch(stored, new RegExp(secret));
	assert.match(stored, /<redacted:/);
	assert.match(stored, /BEGIN/);
	assert.match(stored, /END/);
	assert.equal(record?.sha256.length, 64);
});
