import assert from "node:assert/strict";
import test from "node:test";
import { stripThinkingLabelLines } from "../src/thinking-suppression.ts";

const LABEL = "Thinking...";
const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07";
const ZONE_FINAL = "\x1b]133;C\x07";
const ZONE_END_FINAL = ZONE_END + ZONE_FINAL;

test("returns lines unchanged when label is empty", () => {
	assert.deepEqual(stripThinkingLabelLines(["Thinking...", "text"], ""), ["Thinking...", "text"]);
});

test("returns lines unchanged when no label rows are present", () => {
	assert.deepEqual(stripThinkingLabelLines(["row a", "row b"], LABEL), ["row a", "row b"]);
});

test("removes a single thinking label row", () => {
	assert.deepEqual(stripThinkingLabelLines(["Thinking...", "real text"], LABEL), ["real text"]);
});

test("removes every thinking label row across interleaved runs", () => {
	const lines = ["Thinking...", "tool row", "Thinking...", "tool row 2", "Thinking..."];
	assert.deepEqual(stripThinkingLabelLines(lines, LABEL), ["tool row", "tool row 2"]);
});

test("collapses to empty when only label rows remain", () => {
	assert.deepEqual(stripThinkingLabelLines(["Thinking...", "Thinking..."], LABEL), []);
	assert.deepEqual(stripThinkingLabelLines(["Thinking..."], LABEL), []);
});

test("matches an ANSI-wrapped (italic + fg) label", () => {
	const wrapped = "\x1b[3m\x1b[38;5;245mThinking...\x1b[39m\x1b[23m";
	assert.deepEqual(stripThinkingLabelLines([wrapped, "real text"], LABEL), ["real text"]);
});

test("collapses leftover blank spacer rows", () => {
	const lines = ["", "Thinking...", "", "real text", ""];
	assert.deepEqual(stripThinkingLabelLines(lines, LABEL), ["real text"]);
});

test("migrates OSC 133 zone markers onto surviving edges", () => {
	const lines = [`${ZONE_START}Thinking...`, "row 1", "row 2", `${ZONE_END_FINAL}`];
	const result = stripThinkingLabelLines(lines, LABEL);
	assert.equal(result.length, 2);
	assert.equal(result[0], `${ZONE_START}row 1`);
	assert.equal(result[1], `${ZONE_END_FINAL}row 2`);
});

test("drops zone markers when only label rows remain", () => {
	const lines = [`${ZONE_START}Thinking...`, `${ZONE_END_FINAL}`];
	assert.deepEqual(stripThinkingLabelLines(lines, LABEL), []);
});

test("does not touch rows that merely contain the label word", () => {
	const lines = ["Thinking... is hard", "real text"];
	assert.deepEqual(stripThinkingLabelLines(lines, LABEL), ["Thinking... is hard", "real text"]);
});

test("does not strip when hideThinkingBlock is off (label mismatch)", () => {
	// When thinking blocks are visible, Pi renders full markdown, not the
	// label, so a line equal to the label here is coincidental and must stay.
	assert.deepEqual(stripThinkingLabelLines(["Thinking..."], LABEL), []);
	// verify only exact plain-text equality matches:
	assert.deepEqual(
		stripThinkingLabelLines(["  Thinking...  ", "x"], LABEL),
		["x"],
	);
});
