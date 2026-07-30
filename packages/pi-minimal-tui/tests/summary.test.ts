import assert from "node:assert/strict";
import test from "node:test";
import { formatToolSummary } from "../src/summary.ts";

test("formats compact summaries for built-in tools", () => {
	assert.deepEqual(formatToolSummary("bash", { command: "npm test\nprintf done" }), {
		verb: "Bash",
		detail: "npm test printf done",
	});
	assert.deepEqual(formatToolSummary("grep", { pattern: "renderShell", path: "packages/" }), {
		verb: "Grep",
		detail: "renderShell",
	});
	assert.deepEqual(formatToolSummary("edit", { path: "src/tool-execution.ts" }), {
		verb: "Edit",
		detail: "tool-execution.ts",
	});
});

test("file events show only the final filename across path styles", () => {
	assert.deepEqual(
		formatToolSummary("read", {
			path: "/tmp/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
		}),
		{ verb: "Read", detail: "extensions.md" },
	);
	assert.deepEqual(formatToolSummary("write", { path: "src\\features\\index.ts" }), {
		verb: "Write",
		detail: "index.ts",
	});
});

test("bash actions stay on one bounded line", () => {
	const summary = formatToolSummary("bash", {
		command: `node ./scripts/release.mjs ${"with-a-very-long-argument-".repeat(4)}`,
	});
	assert.equal(summary.verb, "Bash");
	assert.match(summary.detail ?? "", /^node \.\/scripts\/release\.mjs /);
	assert.match(summary.detail ?? "", /…$/);
	assert.ok((summary.detail?.length ?? 0) <= 72);
});
