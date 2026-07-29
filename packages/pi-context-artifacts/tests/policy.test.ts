import assert from "node:assert/strict";
import test from "node:test";
import {
	buildArtifactPreview,
	decideArtifact,
	loadPolicy,
} from "../src/policy.ts";
import type { ArtifactPolicy } from "../src/types.ts";

const policy: ArtifactPolicy = {
	hardTokens: 1000,
	pressureTokens: 500,
	pressurePercent: 65,
	visibleTokens: 200,
	readChunkCharacters: 12_000,
};

test("archives only safe large text results at hard or pressure thresholds", () => {
	const large = [{ type: "text", text: "x".repeat(4000) }];
	assert.equal(decideArtifact("read", large, false, 0, policy, true).archive, true);
	assert.equal(decideArtifact("read", large, false, 0, policy, false).reason, "safety-unavailable");
	assert.equal(decideArtifact("read", large, true, 90, policy, true).reason, "error-result");
	assert.equal(
		decideArtifact("read", [{ type: "image" }], false, 90, policy, true).reason,
		"non-text-result",
	);
	const pressured = [{ type: "text", text: "中".repeat(800) }];
	assert.equal(decideArtifact("read", pressured, false, 65, policy, true).reason, "context-pressure");
	assert.equal(decideArtifact("artifact_read", large, false, 90, policy, true).reason, "recovery-tool");
});

test("builds a bounded head-tail preview with a recoverable artifact pointer", () => {
	const source = `HEAD-${"a".repeat(3000)}-TAIL`;
	const preview = buildArtifactPreview(
		[{ type: "text", text: source }],
		"art_00000000-0000-0000-0000-000000000000",
		1000,
		policy,
	);
	assert.match(preview, /art_00000000-0000-0000-0000-000000000000/);
	assert.match(preview, /HEAD-/);
	assert.match(preview, /-TAIL/);
	assert.ok(preview.length < source.length);
});

test("clamps visible output to a savings-preserving policy", () => {
	const previousHard = process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
	const previousPressure = process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS;
	const previousVisible = process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
	const previousPercent = process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT;
	try {
		process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = "4000";
		process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS = "2000";
		process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = "9000";
		process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT = "150";
		const loaded = loadPolicy();
		assert.equal(loaded.visibleTokens, 1000);
		assert.equal(loaded.pressurePercent, 100);
	} finally {
		if (previousHard === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_HARD_TOKENS = previousHard;
		if (previousPressure === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS = previousPressure;
		if (previousVisible === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS;
		else process.env.PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS = previousVisible;
		if (previousPercent === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT;
		else process.env.PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT = previousPercent;
	}
});
