import assert from "node:assert/strict";
import test from "node:test";
import {
	estimateContentTokens,
	estimateTextTokens,
	OperationPatternTracker,
	parseArtifactizedResultEvent,
	parseVerifiedMilestoneEvent,
	TokenRoiTracker,
} from "../src/index.ts";

test("estimates CJK text more densely than Latin text", () => {
	assert.equal(estimateTextTokens("abcdefgh"), 2);
	assert.equal(estimateTextTokens("中文测试"), 3);
	assert.equal(estimateContentTokens([{ type: "image", mimeType: "image/png", data: "abc" }]), 1200);
});

test("aggregates usage and duplicate tool-result volume without retaining content", () => {
	const tracker = new TokenRoiTracker();
	tracker.reset(new Date("2026-07-29T00:00:00.000Z"));
	tracker.recordAssistantUsage({
		input: 10,
		output: 2,
		cacheRead: 20,
		cacheWrite: 3,
		totalTokens: 35,
		cost: { total: 0.01 },
	});
	tracker.recordToolCall();
	tracker.recordToolYield(1);
	tracker.recordVerifiedMilestone({ kind: "task_completed", count: 2 });
	tracker.recordArtifactizedResult({ originalTokens: 1000, visibleTokens: 100, reused: true });
	const content = [{ type: "text", text: "same result" }];
	tracker.recordToolResult(content, false);
	tracker.recordToolResult(content, true);

	assert.deepEqual(tracker.snapshot(), {
		startedAt: "2026-07-29T00:00:00.000Z",
		assistantRequests: 1,
		toolCalls: 1,
		toolYields: 1,
		toolResults: 2,
		toolErrors: 1,
		toolResultTokens: 6,
		duplicateResults: 1,
		duplicateResultTokens: 3,
		verifiedMilestones: 2,
		milestonesByKind: { task_completed: 2 },
		operationPatterns: {
			readWriteDeleteCandidates: 0,
			directMoves: 0,
		},
		artifactizedResults: 1,
		artifactReuses: 1,
		artifactSourceTokens: 1000,
		artifactTokensVisible: 100,
		artifactTokensSaved: 900,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 20,
			cacheWrite: 3,
			totalTokens: 35,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.01,
			},
		},
	});
});

test("attributes operation shapes without retaining arguments", () => {
	const patterns = new OperationPatternTracker();
	patterns.recordToolCall("read", { path: "/private/source.txt" });
	patterns.recordToolCall("write", { path: "/private/target.txt", content: "secret" });
	patterns.recordToolCall("bash", { command: "rm /private/source.txt" });
	patterns.recordToolCall("bash", { command: "mv a b" });
	assert.deepEqual(patterns.snapshot(), {
		readWriteDeleteCandidates: 1,
		directMoves: 1,
	});
	assert.deepEqual(Object.keys(patterns.snapshot()).sort(), ["directMoves", "readWriteDeleteCandidates"]);
});

test("validates low-cardinality verified milestone events", () => {
	assert.deepEqual(parseVerifiedMilestoneEvent({ kind: "task_completed", count: 2 }), {
		kind: "task_completed",
		count: 2,
	});
	assert.equal(parseVerifiedMilestoneEvent({ kind: "/private/customer/file" }), undefined);
	assert.equal(parseVerifiedMilestoneEvent({ kind: "task_completed", count: 0 }), undefined);
});

test("validates artifact savings events", () => {
	assert.deepEqual(
		parseArtifactizedResultEvent({ originalTokens: 1000, visibleTokens: 100 }),
		{ originalTokens: 1000, visibleTokens: 100, reused: false },
	);
	assert.equal(
		parseArtifactizedResultEvent({ originalTokens: 100, visibleTokens: 100 }),
		undefined,
	);
});
