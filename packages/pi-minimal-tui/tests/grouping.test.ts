import assert from "node:assert/strict";
import test from "node:test";
import { ActionGroupCoordinator, formatGroupedSummary } from "../src/grouping.ts";

test("formats mixed action counts with natural singulars and plurals", () => {
	assert.deepEqual(formatGroupedSummary(["bash", "bash", "read"]), {
		verb: "Read 1 file, ran 2 bash",
	});
	assert.deepEqual(formatGroupedSummary(["read", "read"]), {
		verb: "Read 2 files",
	});
	assert.equal(formatGroupedSummary(["bash"]), undefined);
});

test("the last row represents a group and invalidates earlier rows", () => {
	const grouping = new ActionGroupCoordinator();
	let firstInvalidations = 0;
	grouping.recordTool("call-1", "bash");
	grouping.registerRenderer("call-1", () => {
		firstInvalidations += 1;
	});
	grouping.recordTool("call-2", "read");

	assert.deepEqual(grouping.getView("call-1"), { hidden: true, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, ran 1 bash" },
	});
	assert.equal(firstInvalidations, 1);
});

test("a running agent keeps only its three most recent actions visible", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.startAgent(1_000);
	grouping.recordTool("call-1", "ls");
	grouping.recordTool("call-2", "read");
	grouping.recordTool("call-3", "grep");
	grouping.recordTool("call-4", "grep");

	assert.deepEqual(grouping.getView("call-1"), { hidden: true, marker: "middle" });
	assert.deepEqual(grouping.getView("call-2"), { hidden: false, marker: "middle" });
	assert.deepEqual(grouping.getView("call-3"), { hidden: false, marker: "middle" });
	assert.deepEqual(grouping.getView("call-4"), { hidden: false, marker: "last" });
});

test("agent completion replaces live actions with duration and one aggregate", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.startAgent(1_000);
	grouping.recordTool("call-list", "ls");
	grouping.recordTool("call-read", "read");
	grouping.recordTool("call-grep-1", "grep");
	grouping.recordTool("call-grep-2", "grep");
	grouping.finishAgent(31_000);

	for (const id of ["call-list", "call-read", "call-grep-1"]) {
		assert.deepEqual(grouping.getView(id), { hidden: true, summary: undefined });
	}
	assert.deepEqual(grouping.getView("call-grep-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, searched 2 times, listed 1 directory" },
		marker: "last",
		elapsedMs: 30_000,
	});

	grouping.startAgent(40_000);
	assert.equal(grouping.getView("call-grep-2")?.elapsedMs, 30_000);
});

test("completion keeps elapsed time when final assistant text already closed the action batch", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.startAgent(5_000);
	grouping.recordTool("call-read", "read");
	grouping.recordTool("call-grep", "grep");
	grouping.recordMessage({
		role: "assistant",
		content: [{ type: "text", text: "Here is what I found." }],
	});
	grouping.finishAgent(17_000);

	assert.equal(grouping.getView("call-grep")?.elapsedMs, 12_000);
	assert.equal(grouping.getView("call-grep")?.marker, "last");
});

test("boundaries and errors split action groups", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.recordTool("call-1", "bash");
	grouping.addBoundary();
	grouping.recordTool("call-2", "read");
	assert.equal(grouping.getView("call-1")?.summary, undefined);
	assert.equal(grouping.getView("call-2")?.summary, undefined);

	const grouped = new ActionGroupCoordinator();
	grouped.recordTool("call-1", "bash");
	grouped.recordTool("call-2", "read");
	grouped.markError("call-2");
	assert.equal(grouped.getView("call-1")?.hidden, false);
	assert.equal(grouped.getView("call-1")?.summary, undefined);
	assert.equal(grouped.getView("call-2")?.hidden, false);
	assert.equal(grouped.getView("call-2")?.summary, undefined);
});

test("session replay does not merge actions across user turns", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.rebuild([
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
			},
		},
		{ message: { role: "user", content: [{ type: "text", text: "next" }] } },
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
			},
		},
	]);

	assert.equal(grouping.getView("call-1")?.summary, undefined);
	assert.equal(grouping.getView("call-2")?.summary, undefined);
});

test("thinking does not split live action groups", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.recordTool("call-1", "bash");
	grouping.recordMessage({
		role: "assistant",
		content: [{ type: "thinking", thinking: "Inspect the result before continuing." }],
	});
	grouping.recordTool("call-2", "read");

	assert.deepEqual(grouping.getView("call-1"), { hidden: true, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, ran 1 bash" },
	});
});

test("session replay merges actions across thinking", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.rebuild([
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "First batch." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
				],
			},
		},
		{ message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [] } },
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Reassess before the next action." },
					{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
				],
			},
		},
	]);

	assert.deepEqual(grouping.getView("call-1"), { hidden: true, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, ran 1 bash" },
	});
});

test("file browsing actions merge across repeated thinking segments", () => {
	const grouping = new ActionGroupCoordinator();
	const actions = [
		["call-list", "ls"],
		["call-read", "read"],
		["call-grep-1", "grep"],
		["call-grep-2", "grep"],
	] as const;

	for (const [id, name] of actions) {
		grouping.recordMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Continue inspecting the code." },
				{ type: "toolCall", id, name, arguments: {} },
			],
		});
	}

	for (const [id] of actions.slice(0, -1)) {
		assert.deepEqual(grouping.getView(id), { hidden: true, summary: undefined });
	}
	assert.deepEqual(grouping.getView("call-grep-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, searched 2 times, listed 1 directory" },
	});
});

test("tool calls after one thinking block remain in the same batch", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.recordMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Run the independent checks together." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
			{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
		],
	});

	assert.deepEqual(grouping.getView("call-1"), { hidden: true, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), {
		hidden: false,
		summary: { verb: "Read 1 file, ran 1 bash" },
	});
});

test("session replay reconstructs thought duration from entry timestamps", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.rebuild([
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }, { type: "toolCall", id: "c2", name: "grep", arguments: {} }] } },
		{ type: "message", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [] } },
		{ type: "message", timestamp: "2026-01-01T00:00:07.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "grep", content: [] } },
		{ type: "message", timestamp: "2026-01-01T00:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
	]);

	assert.equal(grouping.getView("c1")?.hidden, true);
	assert.equal(grouping.getView("c2")?.marker, "last");
	assert.equal(grouping.getView("c2")?.elapsedMs, 20_000);
	assert.deepEqual(grouping.getView("c2")?.summary, { verb: "Read 1 file, searched 1 time" });
});

test("session replay closes each turn at the next user message", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.rebuild([
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] } },
		{ type: "message", timestamp: "2026-01-01T00:00:11.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [] } },
		{ type: "message", timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		{ type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "again" }] } },
		{ type: "message", timestamp: "2026-01-01T00:01:05.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "grep", arguments: {} }] } },
		{ type: "message", timestamp: "2026-01-01T00:01:06.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "grep", content: [] } },
		{ type: "message", timestamp: "2026-01-01T00:01:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
	]);

	assert.equal(grouping.getView("c1")?.elapsedMs, 30_000);
	assert.equal(grouping.getView("c2")?.elapsedMs, 20_000);
});
