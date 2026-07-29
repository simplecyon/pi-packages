import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCheckpoint } from "../src/checkpoint.ts";
import { serializeMessages } from "../src/messages.ts";
import { searchHistory } from "../src/search.ts";
import { appendSegment, readSegments } from "../src/storage.ts";
import { MAX_CHECKPOINT_CHARS, type HistorySegment } from "../src/types.ts";

test("serializes user, thinking, tool calls and tool results", () => {
	const messages = serializeMessages([
		{ role: "user", content: [{ type: "text", text: "Keep package-only." }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect the package API." },
				{ type: "toolCall", name: "read", arguments: { path: "docs/extensions.md" } },
			],
		},
		{
			role: "toolResult",
			content: [{ type: "text", text: "session_before_compact is available" }],
		},
	]);

	assert.equal(messages.length, 3);
	assert.match(messages[1].text, /\[thinking\]/);
	assert.deepEqual(messages[1].toolCalls, [
		{ name: "read", arguments: { path: "docs/extensions.md" } },
	]);
	assert.match(messages[2].text, /session_before_compact/);
});

test("builds a bounded whitelist checkpoint with a stable retrieval pointer", () => {
	const messages = serializeMessages([
		{ role: "user", content: [{ type: "text", text: "First exact preference." }] },
		{
			role: "user",
			content: [{ type: "text", text: `必须 package-only。${"旧上下文 ".repeat(2000)}` }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Implemented the storage layer." },
				{ type: "toolCall", name: "write", arguments: { path: "src/storage.ts" } },
			],
		},
	]);
	const summary = buildCheckpoint(messages, "segment-1");

	assert.ok(summary.length <= MAX_CHECKPOINT_CHARS);
	assert.match(summary, /<continuation_checkpoint/);
	assert.match(summary, /<constraints>/);
	assert.match(summary, /First exact preference/);
	assert.match(summary, /src\/storage.ts/);
	assert.match(summary, /compact_search/);
	assert.match(summary, /segment-1/);
});

test("only explicit runtime failures become unresolved errors", () => {
	const documentation = buildCheckpoint(
		serializeMessages([
			{ role: "user", content: "Read the extension documentation." },
			{
				role: "toolResult",
				content: [{ type: "text", text: "The error handler catches failed requests and exceptions." }],
			},
		]),
		"segment-docs",
	);
	assert.doesNotMatch(documentation, /<unresolved_errors>/);

	const failure = buildCheckpoint(
		serializeMessages([
			{ role: "user", content: "Run the tests." },
			{
				role: "toolResult",
				content: [{ type: "text", text: "npm test exited with code 1" }],
				isError: true,
			},
		]),
		"segment-error",
	);
	assert.match(failure, /<unresolved_errors>/);
	assert.match(failure, /npm test exited with code 1/);
});

test("search returns a bounded snippet instead of replaying a huge tool result", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-compact-snippet-"));
	const previousRoot = process.env.PI_CONTEXT_COMPACT_DIR;
	process.env.PI_CONTEXT_COMPACT_DIR = root;
	try {
		await appendSegment({
			type: "segment",
			schemaVersion: 1,
			id: "segment-large",
			sessionRef: "session-large",
			createdAt: "2026-07-28T00:00:00.000Z",
			reason: "threshold",
			isSplitTurn: false,
			messages: serializeMessages([
				{
					role: "toolResult",
					content: [{ type: "text", text: `${"prefix ".repeat(2000)}needle${" suffix".repeat(2000)}` }],
				},
			]),
		});
		const [hit] = await searchHistory("session-large", "needle", 1);
		assert.ok(hit);
		assert.ok(hit.text.length <= 1602);
		assert.match(hit.text, /needle/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_CONTEXT_COMPACT_DIR;
		else process.env.PI_CONTEXT_COMPACT_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("append-only history is searchable and tolerates independent sessions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-compact-"));
	const previousRoot = process.env.PI_CONTEXT_COMPACT_DIR;
	process.env.PI_CONTEXT_COMPACT_DIR = root;
	try {
		const segment: HistorySegment = {
			type: "segment",
			schemaVersion: 1,
			id: "segment-1",
			sessionRef: "session-a",
			createdAt: "2026-07-28T00:00:00.000Z",
			reason: "manual",
			isSplitTurn: false,
			messages: serializeMessages([
				{ role: "toolResult", content: [{ type: "text", text: "Exact reload renderer failure" }] },
			]),
		};
		await appendSegment(segment);

		assert.equal((await readSegments("session-a")).length, 1);
		assert.equal((await readSegments("session-b")).length, 0);
		const hits = await searchHistory("session-a", "reload renderer", 5);
		assert.equal(hits.length, 1);
		assert.match(hits[0].text, /Exact reload renderer failure/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_CONTEXT_COMPACT_DIR;
		else process.env.PI_CONTEXT_COMPACT_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});
