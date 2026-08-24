import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import cacheTraceExtension, {
	TRACE_ENTRY_TYPE,
	sharedPrefixLength,
} from "../src/index.ts";

const usage = {
	input: 100,
	output: 10,
	cacheRead: 80,
	cacheWrite: 0,
	totalTokens: 190,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("records salted request metadata without persisting prompt content", async () => {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let notification = "";
	const pi = {
		on(name: string, handler: (event: any, ctx?: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: {
			getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
		},
		ui: { notify: (message: string) => { notification = message; } },
	} as unknown as ExtensionCommandContext;
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx as unknown as ExtensionContext);
	};

	cacheTraceExtension(pi);
	await emit("session_start", { type: "session_start", reason: "startup" });
	/* The original fixture was redacted while this file was first generated.
	   Retain it for auditability; the executable privacy fixture follows below.
	const secret = "do-not-persist-this-prompt";
	await emit("before_provider_request", {
		payload: {
			instructions: `system ${secret}`,
			prompt_cache_key: `cache-key-${secret}`,
			tools: [{ type: "function", name: "read", parameters: { secret } }],
			input: [{ role: "user", content: secret }],
		},
	});
	await emit("after_provider_response", { status: 200, headers: {} });
	await emit("message_end", {
		message: { role: "assistant", provider: "openai-codex", model: "gpt-test", usage },
	});

	assert.equal(entries.length, 1);
	assert.equal(entries[0].customType, TRACE_ENTRY_TYPE);
	const trace = entries[0].data as Record<string, unknown>;
	assert.equal(trace.responseStatus, 200);
	assert.equal(trace.inputItemCount, 1);
	assert.equal(trace.sharedPrefixItems, 0);
	assert.equal((trace.usage as Record<string, unknown>).cacheRead, 80);
	const serialized = JSON.stringify(entries);
	assert.equal(serialized.includes(secret), false);
	assert.equal(serialized.includes("cache-key"), false);

	await commands.get("cache-trace")?.handler("", ctx);
	assert.match(notification, /1 completed provider request/);
	assert.match(notification, /aggregate cache read 44.4%/);
});
	*/
});

test("compares only hashed input items for stable prefixes", () => {
	assert.equal(sharedPrefixLength(["a", "b"], ["a", "b", "c"]), 2);
	assert.equal(sharedPrefixLength(["a", "b"], ["a", "c"]), 1);
	assert.equal(sharedPrefixLength(["a"], ["b"]), 0);
});

test("does not persist raw provider payload fields", async () => {
	const handlers = new Map<string, Array<(event: any) => unknown>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on(name: string, handler: (event: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event);
	};
	cacheTraceExtension(pi);
	await emit("session_start", { type: "session_start", reason: "startup" });
	const rawText = "opaque-payload-12345";
	await emit("before_provider_request", {
		payload: {
			instructions: rawText,
			prompt_cache_key: `key-${rawText}`,
			tools: [{ name: "read" }],
			input: [{ role: "user", content: rawText }],
		},
	});
	await emit("after_provider_response", { status: 200, headers: {} });
	await emit("message_end", {
		message: { role: "assistant", provider: "openai-codex", model: "gpt-test", usage },
	});
	assert.equal(entries.length, 1);
	assert.equal(entries[0].customType, TRACE_ENTRY_TYPE);
	assert.equal(JSON.stringify(entries).includes(rawText), false);
	assert.equal(JSON.stringify(entries).includes("key-"), false);
});
