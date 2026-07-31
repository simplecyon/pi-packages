import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDuration,
	isInteractiveTool,
	isTimeoutResult,
	percentile,
	summarizeRecords,
	type RuntimeRecord,
} from "../src/runtime.ts";

test("percentile and duration formatting stay deterministic", () => {
	assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
	assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
	assert.equal(formatDuration(820), "820ms");
	assert.equal(formatDuration(8_200), "8.2s");
	assert.equal(formatDuration(82_000), "1.4m");
});

test("interactive and timeout classification is metadata-only", () => {
	assert.equal(isInteractiveTool("AskUserQuestion"), true);
	assert.equal(isInteractiveTool("bash"), false);
	assert.equal(isTimeoutResult({ content: [{ text: "Command timed out after 30 seconds" }] }), true);
	assert.equal(isTimeoutResult({ content: [{ text: "completed" }] }), false);
});

test("summary separates model, tool, and interactive waiting", () => {
	const records: RuntimeRecord[] = [
		{ phase: "model-after-user", durationMs: 10_000, recordedAt: "2026-07-31T00:00:00Z" },
		{ phase: "model-after-tool", durationMs: 20_000, recordedAt: "2026-07-31T00:00:01Z" },
		{
			phase: "approval",
			toolName: "bash",
			durationMs: 15_000,
			recordedAt: "2026-07-31T00:00:02Z",
		},
		{
			phase: "tool",
			toolName: "bash",
			durationMs: 30_000,
			recordedAt: "2026-07-31T00:00:03Z",
			timedOut: true,
			isError: true,
		},
		{
			phase: "tool",
			toolName: "AskUserQuestion",
			durationMs: 60_000,
			recordedAt: "2026-07-31T00:00:04Z",
			isInteractive: true,
		},
	];
	const summary = summarizeRecords(records);
	assert.match(summary, /Model after user: n=1/);
	assert.match(summary, /Safety approval: n=1/);
	assert.match(summary, /Tool split: 1 execution-like, 1 interactive\/waiting, 1 approvals/);
	assert.match(summary, /bash: 30s \(timeout, error\)/);
});
