import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installCompactUserMessageRendering } from "../src/user-message.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

test("user message collapses to a single content row without padding", () => {
	initTheme("dark");
	installCompactUserMessageRendering();
	installCompactUserMessageRendering();

	const lines = new UserMessageComponent("compact message").render(48);

	// 只 1 行内容，无上下 padding
	assert.equal(lines.length, 1);

	// OSC133 标记移到内容行首尾
	assert.ok(lines[0]?.startsWith(OSC133_ZONE_START));
	assert.ok(lines[0]?.endsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL));

	// 内容行保留 #343541 色块 + > 前缀 + medium
	assert.ok(lines[0]?.includes("\x1b[48;2;52;53;65m"));
	assert.ok(lines[0]?.includes("\x1b[2m>\x1b[22m "));
	assert.ok(lines[0]?.includes("\x1b[1m"));
	assert.equal(lines[0]?.replace(ANSI_PATTERN, "").trimEnd(), "> compact message");
});

test("multi-line user message keeps OSC133 only on first and last content rows", () => {
	initTheme("dark");
	installCompactUserMessageRendering();

	const first = new UserMessageComponent("first line\nsecond line\nthird line").render(80);
	assert.ok(first.length >= 3);
	assert.ok(first[0]?.startsWith(OSC133_ZONE_START));
	assert.ok(first[first.length - 1]?.endsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL));
	// 中间行不带 OSC133 标记
	for (let i = 1; i < first.length - 1; i++) {
		assert.ok(!first[i]?.includes(OSC133_ZONE_START));
		assert.ok(!first[i]?.includes(OSC133_ZONE_END));
	}
});
