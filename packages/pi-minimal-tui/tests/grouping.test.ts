import assert from "node:assert/strict";
import test from "node:test";
import { ActionGroupCoordinator, formatGroupedSummary } from "../src/grouping.ts";

test("formats mixed action counts with natural singulars and plurals", () => {
	assert.deepEqual(formatGroupedSummary(["bash", "bash", "read"]), {
		verb: "Ran 2 shell commands, read 1 file",
		bullet: false,
	});
	assert.deepEqual(formatGroupedSummary(["read", "read"]), {
		verb: "Read 2 files",
		bullet: false,
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
		summary: { verb: "Ran 1 shell command, read 1 file", bullet: false },
	});
	assert.equal(firstInvalidations, 1);
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

test("thinking splits live action groups", () => {
	const grouping = new ActionGroupCoordinator();
	grouping.recordTool("call-1", "bash");
	grouping.recordMessage({
		role: "assistant",
		content: [{ type: "thinking", thinking: "Inspect the result before continuing." }],
	});
	grouping.recordTool("call-2", "read");

	assert.deepEqual(grouping.getView("call-1"), { hidden: false, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), { hidden: false, summary: undefined });
});

test("session replay does not merge actions across thinking", () => {
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

	assert.deepEqual(grouping.getView("call-1"), { hidden: false, summary: undefined });
	assert.deepEqual(grouping.getView("call-2"), { hidden: false, summary: undefined });
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
		summary: { verb: "Ran 1 shell command, read 1 file", bullet: false },
	});
});
