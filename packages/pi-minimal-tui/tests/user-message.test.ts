import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installCompactUserMessageRendering } from "../src/user-message.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

test("user message keeps padding rows as bg-less whitespace around a colored content row", () => {
	initTheme("dark");
	installCompactUserMessageRendering();
	installCompactUserMessageRendering();

	const lines = new UserMessageComponent("compact message").render(48);

	// 顶部留白 + 内容 + 底部留白
	assert.equal(lines.length, 3);

	// 顶部留白: OSC133 start, visually blank, 无背景色块(终端背景)
	assert.ok(lines[0]?.includes(OSC133_ZONE_START));
	assert.ok(!lines[0]?.includes(OSC133_ZONE_END));
	assert.equal(lines[0]?.replace(ANSI_PATTERN, "").trim().length, 0);
	assert.ok(!lines[0]?.includes("\x1b[48;"));

	// 内容行: 保留 #343541 色块 + > 前缀 + medium
	assert.ok(lines[1]?.includes("compact message"));
	assert.ok(!lines[1]?.includes(OSC133_ZONE_START));
	assert.ok(!lines[1]?.includes(OSC133_ZONE_END));
	assert.ok(lines[1]?.includes("\x1b[48;2;52;53;65m"));
	assert.ok(lines[1]?.includes("\x1b[2m>\x1b[22m "));
	assert.ok(lines[1]?.includes("\x1b[1m"));
	assert.equal(lines[1]?.replace(ANSI_PATTERN, "").trimEnd(), "> compact message");

	// 底部留白: OSC133 end+final, visually blank, 无背景色块
	assert.ok(lines[2]?.includes(OSC133_ZONE_END));
	assert.ok(lines[2]?.includes(OSC133_ZONE_FINAL));
	assert.equal(lines[2]?.replace(ANSI_PATTERN, "").trim().length, 0);
	assert.ok(!lines[2]?.includes("\x1b[48;"));
});
