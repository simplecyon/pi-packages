import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	TOKEN_ROI_ARTIFACT_EVENT,
	TOKEN_ROI_MILESTONE_EVENT,
} from "@simplecyon/pi-context-core";
import tokenRoiExtension, { parseExportPath } from "../src/index.ts";

test("only accepts an exact --json export flag", () => {
	assert.equal(parseExportPath("--jsonfoo", "/tmp"), undefined);
	assert.equal(parseExportPath("--json report.json", "/tmp"), "/tmp/report.json");
});

test("observes events and exports aggregate JSON without prompt or result contents", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-token-roi-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const notifications: string[] = [];
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
			commands.set(name, command);
		},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const list = busHandlers.get(name) ?? [];
				list.push(handler);
				busHandlers.set(name, list);
				return () => {};
			},
			emit(name: string, data: unknown) {
				for (const handler of busHandlers.get(name) ?? []) handler(data);
			},
		},
		getActiveTools: () => ["read"],
		getAllTools: () => [{
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute: async () => ({ content: [] }),
		}],
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		mode: "tui",
		sessionManager: { getSessionId: () => "session-test" },
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx as unknown as ExtensionContext);
		}
	};

	tokenRoiExtension(pi);
	assert.deepEqual([...commands.keys()], ["roi"]);
	assert.equal((pi as unknown as { registerTool?: unknown }).registerTool, undefined);
	await emit("session_start", { type: "session_start", reason: "startup" });
	pi.events.emit(TOKEN_ROI_MILESTONE_EVENT, { kind: "task_completed" });
	pi.events.emit(TOKEN_ROI_ARTIFACT_EVENT, {
		originalTokens: 10_000,
		visibleTokens: 1_000,
	});
	await emit("message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 32,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		},
	});
	await emit("tool_call", {
		type: "tool_call",
		toolName: "read",
		toolCallId: "1",
		input: { path: "/private/source.txt" },
	});
	await emit("tool_call", {
		type: "tool_call",
		toolName: "write",
		toolCallId: "2",
		input: { path: "/private/target.txt", content: "do-not-export-this-input" },
	});
	await emit("tool_call", {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "3",
		input: { command: "rm /private/source.txt" },
	});
	const secretResult = "do-not-export-this-result";
	await emit("tool_result", {
		type: "tool_result",
		toolName: "read",
		toolCallId: "1",
		input: {},
		content: [{ type: "text", text: secretResult }],
		isError: false,
	});
	await emit("turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [{}] });

	const command = commands.get("roi");
	assert.ok(command);
	await command.handler("--json", ctx);
	const reportPath = join(root, ".pi", "roi", "roi-latest.json");
	const raw = await readFile(reportPath, "utf8");
	const report = JSON.parse(raw);
	assert.equal(report.assistantRequests, 1);
	assert.equal(report.toolCalls, 3);
	assert.equal(report.toolYields, 1);
	assert.equal(report.verifiedMilestones, 1);
	assert.equal(report.economics.economicTokensPerMilestone, 32);
	assert.equal(report.operationPatterns.readWriteDeleteCandidates, 1);
	assert.equal(report.artifactizedResults, 1);
	assert.equal(report.artifactTokensSaved, 9000);
	assert.equal(report.advice[0].code, "relocation_candidate");
	assert.equal(report.sessionId, "session-test");
	assert.equal(report.context.tokens, 100);
	assert.equal(report.activeTools.count, 1);
	assert.equal(raw.includes(secretResult), false);
	assert.equal(raw.includes("do-not-export-this-input"), false);
	assert.equal(raw.includes("/private/source.txt"), false);
	assert.equal(raw.includes("fingerprint"), false);
	assert.match(notifications.at(-1) ?? "", /written to/);
});
