import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolRuntimeExtension from "../src/index.ts";

test("registers guidance, metadata-only telemetry, and runtime summary", async () => {
	const handlers = new Map<string, Array<(event: any, context?: any) => any>>();
	const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
	const entries: Array<{ customType: string; data: any }> = [];
	const bus = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		on(name: string, handler: (event: any, context?: any) => any) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		events: {
			on(name: string, handler: (payload: unknown) => void) {
				const current = bus.get(name) ?? [];
				current.push(handler);
				bus.set(name, current);
				return () => {};
			},
			emit(name: string, payload: unknown) {
				for (const handler of bus.get(name) ?? []) handler(payload);
			},
		},
	} as unknown as ExtensionAPI;
	toolRuntimeExtension(pi);

	const beforeStart = handlers.get("before_agent_start")?.[0];
	assert.ok(beforeStart);
	const promptResult = await beforeStart({ systemPrompt: "base" });
	assert.match(promptResult.systemPrompt, /Tool Runtime Budget/);
	assert.match(promptResult.systemPrompt, /timeout values as seconds/);

	await handlers.get("message_end")?.[0]({ message: { role: "user" } });
	await handlers.get("message_start")?.[0]({ message: { role: "assistant" } });
	await handlers.get("tool_execution_start")?.[0]({
		toolCallId: "tool-1",
		toolName: "bash",
		args: { command: "secret command must not be stored" },
	});
	(pi as any).events.emit("simplecyon:tool-runtime:approval-end", {
		toolCallId: "tool-1",
		toolName: "bash",
		durationMs: 10,
	});
	await handlers.get("tool_execution_end")?.[0]({
		toolCallId: "tool-1",
		toolName: "bash",
		result: { content: [{ text: "Command timed out after 30 seconds" }] },
		isError: true,
	});

	assert.equal(entries.length, 3);
	assert.equal(entries.every((entry) => entry.customType === "tool-runtime-event"), true);
	const serialized = JSON.stringify(entries);
	assert.doesNotMatch(serialized, /secret command/);
	assert.match(serialized, /model-after-user/);
	assert.match(serialized, /"phase":"approval"/);
	assert.match(serialized, /"timedOut":true/);

	let notification = "";
	const runtime = commands.get("runtime");
	assert.ok(runtime);
	await runtime.handler("", {
		ui: {
			notify(value: string) {
				notification = value;
			},
		},
	});
	assert.match(notification, /Model after user: n=1/);
	assert.match(notification, /bash:/);
});
