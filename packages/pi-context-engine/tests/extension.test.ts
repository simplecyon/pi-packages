import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import contextEngineExtension from "../src/index.ts";
import { readStore } from "../src/storage.ts";

test("wires redacted continuity, dynamic unified search, and status commands", async (t) => {
	const storeRoot = await mkdtemp(join(tmpdir(), "pi-context-engine-extension-store-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-engine-extension-project-"));
	const previous = process.env.PI_CONTEXT_ENGINE_DIR;
	process.env.PI_CONTEXT_ENGINE_DIR = storeRoot;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ENGINE_DIR;
		else process.env.PI_CONTEXT_ENGINE_DIR = previous;
		await rm(storeRoot, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const bus = new Map<string, Array<(data: any) => void>>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const notifications: string[] = [];
	let activeTools: string[] = [];
	const events = {
		on(name: string, handler: (data: any) => void) {
			const list = bus.get(name) ?? [];
			list.push(handler);
			bus.set(name, list);
			return () => {};
		},
		emit(name: string, data: any) {
			if (name === "simplecyon:safe-operation:discover") {
				for (const handler of bus.get("simplecyon:safe-operation:available") ?? []) {
					handler({
						owner: "@simplecyon/pi-safe-operation",
						protocolVersion: 1,
						redactsToolResults: true,
					});
				}
			}
			if (name === "simplecyon:safe-operation:redact") {
				const block = data.value?.content?.[0];
				if (block?.type === "text") {
					block.text = block.text.replaceAll("secret", "[REDACTED]");
				}
			}
			if (name === "simplecyon:context-engine:compact-search") {
				data.searches.push(Promise.resolve([{
					segmentId: "compact-1",
					createdAt: "2026-07-29T00:00:00.000Z",
					role: "toolResult",
					text: "compacted restart evidence",
					score: 9,
				}]));
			}
			for (const handler of bus.get(name) ?? []) handler(data);
		},
	};
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
			activeTools.push(tool.name);
		},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
			commands.set(name, command);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		events,
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: projectDir,
		sessionManager: {
			getSessionFile: () => "/sessions/context-engine.jsonl",
			getBranch: () => [],
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	contextEngineExtension(pi);
	assert.deepEqual([...tools.keys()], ["context_run", "context_index", "context_search"]);
	assert.deepEqual(
		[...commands.keys()],
		["context-engine", "context-doctor", "context-migrate", "context-purge"],
	);
	await emit("session_start", { type: "session_start" });
	assert.equal(activeTools.includes("context_search"), false);
	await emit("before_agent_start", {
		type: "before_agent_start",
		prompt: "后续必须提升 token ROI，secret",
	});
	assert.equal(activeTools.includes("context_search"), true);

	const indexTool = tools.get("context_index");
	assert.ok(indexTool);
	await indexTool.execute(
		"index-1",
		{ source: "manual", content: "END-MANUAL-ROI secret" },
		undefined,
		undefined,
		ctx,
	);
	await emit("tool_result", {
		type: "tool_result",
		toolName: "bash",
		input: { command: "git status && echo secret-command" },
		content: [{ type: "text", text: "secret-result" }],
		isError: false,
	});

	const searchTool = tools.get("context_search");
	assert.ok(searchTool);
	const result = await searchTool.execute(
		"search-1",
		{ query: "restart evidence", limit: 5 },
		undefined,
		undefined,
		ctx,
	);
	assert.match((result.content[0] as { text: string }).text, /compacted restart evidence/);
	const manualOnly = await searchTool.execute(
		"search-2",
		{ query: "END-MANUAL-ROI", source: "manual", limit: 5 },
		undefined,
		undefined,
		ctx,
	);
	assert.match((manualOnly.content[0] as { text: string }).text, /END-MANUAL-ROI/);
	assert.doesNotMatch((manualOnly.content[0] as { text: string }).text, /compacted restart/);

	const store = await readStore(projectDir);
	const serialized = JSON.stringify(store);
	assert.match(serialized, /\[REDACTED\]/);
	assert.match(serialized, /git status/);
	assert.doesNotMatch(serialized, /secret-command|secret-result/);

	await commands.get("context-engine")?.handler("", ctx);
	assert.match(notifications.at(-1) ?? "", /Pi context engine/);
	await commands.get("context-purge")?.handler("", ctx);
	assert.match(notifications.at(-1) ?? "", /Usage/);
});
