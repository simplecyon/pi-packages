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
import contextArtifactsExtension from "../src/index.ts";
import { listArtifacts, readArtifact } from "../src/storage.ts";

test("gates persistence on redaction capability and dynamically activates exact retrieval", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-artifacts-extension-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousRoot = process.env.PI_CONTEXT_ARTIFACTS_DIR;
	const previousHard = process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
	const previousVisible = process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
	process.env.PI_CONTEXT_ARTIFACTS_DIR = root;
	process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = "4000";
	process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = "500";
	t.after(() => {
		if (previousRoot === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_DIR;
		else process.env.PI_CONTEXT_ARTIFACTS_DIR = previousRoot;
		if (previousHard === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = previousHard;
		if (previousVisible === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = previousVisible;
	});

	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	let activeTools: string[] = [];
	const roiEvents: unknown[] = [];
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
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const list = bus.get(name) ?? [];
				list.push(handler);
				bus.set(name, list);
				return () => {};
			},
			emit(name: string, data: unknown) {
				if (name === "token-roi:artifactized-result") roiEvents.push(data);
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/project",
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		sessionManager: {
			getSessionFile: () => "/sessions/a.jsonl",
			getSessionId: () => "session-a",
		},
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => {
		let current = event as any;
		let result: any;
		for (const handler of handlers.get(name) ?? []) {
			result = await handler(current, ctx);
			if (name === "tool_result" && result?.content) {
				current = { ...current, ...result };
			}
		}
		return result;
	};

	contextArtifactsExtension(pi);
	await emit("session_start", { type: "session_start", reason: "startup" });
	assert.deepEqual(activeTools, []);
	const source = `BEGIN\n${"safe result line\n".repeat(5000)}END`;
	const event = {
		type: "tool_result",
		toolName: "read",
		toolCallId: "read-1",
		input: { path: "/private/source" },
		content: [{ type: "text", text: source }],
		details: { privateArgument: "/private/source" },
		isError: false,
	};
	assert.equal(await emit("tool_result", event), undefined);
	assert.deepEqual(await listArtifacts("/sessions/a.jsonl"), []);

	pi.events.emit("simplecyon:safe-operation:available", {
		owner: "@simplecyon/pi-safe-operation",
		protocolVersion: 1,
		redactsToolResults: true,
	});
	const bounded = await emit("tool_result", event) as { content: Array<{ text: string }> };
	assert.match(bounded.content[0]?.text ?? "", /Large tool result archived as art_/);
	assert.ok((bounded.content[0]?.text.length ?? Infinity) < source.length);
	assert.deepEqual(activeTools, ["artifact_read"]);
	assert.equal(roiEvents.length, 1);
	const repeated = await emit("tool_result", event) as { content: Array<{ text: string }> };
	const artifactId = bounded.content[0]?.text.match(/art_[a-f0-9-]{36}/)?.[0];
	assert.ok(artifactId);
	assert.match(repeated.content[0]?.text ?? "", new RegExp(artifactId));
	assert.equal((await listArtifacts("/sessions/a.jsonl")).length, 1);
	assert.deepEqual(roiEvents[1], {
		originalTokens: (roiEvents[0] as { originalTokens: number }).originalTokens,
		visibleTokens: (roiEvents[0] as { visibleTokens: number }).visibleTokens,
		reused: true,
	});

	const [artifact] = await listArtifacts("/sessions/a.jsonl");
	assert.ok(artifact);
	const record = await readArtifact("/sessions/a.jsonl", artifact.id);
	assert.equal(record?.content[0]?.text, source);
	assert.equal(JSON.stringify(record).includes("/private/source"), false);

	const retrieval = tools.get("artifact_read");
	assert.ok(retrieval);
	const firstChunk = await retrieval.execute(
		"artifact-1",
		{ id: artifact.id, offset: 0, limit: 12000 },
		undefined,
		undefined,
		ctx,
	);
	assert.match((firstChunk.content[0] as { text: string }).text, /BEGIN/);
	assert.equal((firstChunk.details as { nextOffset: number }).nextOffset, 12000);
	let recovered = "";
	let offset = 0;
	while (true) {
		const result = await retrieval.execute(
			`artifact-${offset}`,
			{ id: artifact.id, offset, limit: 12000 },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		recovered += text.slice(text.indexOf("\n\n") + 2);
		const nextOffset = (result.details as { nextOffset: number | null }).nextOffset;
		if (nextOffset == null) break;
		offset = nextOffset;
	}
	assert.equal(recovered, source);
	const searched = await retrieval.execute(
		"artifact-search",
		{ id: artifact.id, query: "END" },
		undefined,
		undefined,
		ctx,
	);
	const searchedText = (searched.content[0] as { text: string }).text;
	assert.match(searchedText, /1 match/);
	assert.match(
		searchedText,
		new RegExp(`match at char ${source.length - 3}; context chars`),
	);
	assert.deepEqual((searched.details as { matchOffsets: number[] }).matchOffsets, [source.length - 3]);

	process.env.PI_CONTEXT_ARTIFACTS_DIR = "/dev/null/not-a-directory";
	const failedArchive = await emit("tool_result", {
		...event,
		toolCallId: "read-storage-failure",
		content: [{ type: "text", text: `${source}\ndifferent` }],
	});
	assert.equal(failedArchive, undefined);
	assert.ok(commands.has("artifacts"));
});
