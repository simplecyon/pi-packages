import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installCompactUserMessageRendering } from "../src/user-message.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

test("user message uses background padding instead of a foreground strip", () => {
	initTheme("dark");
	installCompactUserMessageRendering();
	installCompactUserMessageRendering();

	const lines = new UserMessageComponent("compact message").render(48);

	// 顶部 padding + 内容 + 底部 padding
	assert.equal(lines.length, 3);

	// 顶部 padding: OSC133 start + 背景色, visually blank
	assert.ok(lines[0]?.includes(OSC133_ZONE_START));
	assert.ok(!lines[0]?.includes(OSC133_ZONE_END));
	assert.ok(!lines[0]?.includes(OSC133_ZONE_FINAL));
	assert.equal(lines[0]?.replace(ANSI_PATTERN, "").trim().length, 0);
	assert.ok(lines[0]?.includes("\x1b[48;"));

	// 内容行: > 前缀 + medium
	assert.ok(lines[1]?.includes("compact message"));
	assert.ok(!lines[1]?.includes(OSC133_ZONE_START));
	assert.ok(!lines[1]?.includes(OSC133_ZONE_END));
	assert.ok(lines[1]?.includes("\x1b[2m>\x1b[22m "));
	assert.ok(lines[1]?.includes("\x1b[1m"));
	assert.equal(lines[1]?.replace(ANSI_PATTERN, "").trimEnd(), "> compact message");

	// 底部 padding: OSC133 end+final + 背景色, 无 ▔ 前景线
	assert.ok(lines[2]?.includes(OSC133_ZONE_END));
	assert.ok(lines[2]?.includes(OSC133_ZONE_FINAL));
	assert.ok(!lines[2]?.includes("\u{1fb82}"));
	assert.ok(!lines[2]?.includes("\x1b[38;2;"));
	assert.ok(lines[2]?.includes("\x1b[48;"));
	assert.equal(lines[2]?.replace(ANSI_PATTERN, "").trim().length, 0);
});
