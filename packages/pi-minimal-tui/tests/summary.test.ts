import assert from "node:assert/strict";
import test from "node:test";
import { formatToolSummary } from "../src/summary.ts";

test("formats compact summaries for built-in tools", () => {
	assert.deepEqual(formatToolSummary("bash", { command: "npm test\nprintf done" }), {
		verb: "bash",
		detail: "npm test printf done",
	});
	assert.deepEqual(formatToolSummary("grep", { pattern: "renderShell", path: "packages/" }), {
		verb: "grep",
		detail: "\"renderShell\" in packages/",
	});
	assert.deepEqual(formatToolSummary("edit", { path: "src/tool-execution.ts" }), {
		verb: "edit",
		detail: "src/tool-execution.ts",
	});
});

test("classifies Pi docs and skills", () => {
	assert.deepEqual(
		formatToolSummary("read", {
			path: "/tmp/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
		}),
		{ verb: "read", detail: "docs: extensions.md" },
	);
	assert.deepEqual(formatToolSummary("read", { path: "/tmp/skills/thinker/SKILL.md" }), {
		verb: "read",
		detail: "skill: thinker",
	});
});
