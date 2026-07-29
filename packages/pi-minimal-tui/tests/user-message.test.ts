import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { installCompactUserMessageRendering } from "../src/user-message.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

test("user message highlight keeps content but removes vertical padding rows", () => {
	initTheme("dark");
	installCompactUserMessageRendering();
	installCompactUserMessageRendering();

	const lines = new UserMessageComponent("compact message").render(48);

	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("compact message"));
	assert.ok(lines[0]?.includes(OSC133_ZONE_START));
	assert.ok(lines[0]?.includes(OSC133_ZONE_END));
	assert.ok(lines[0]?.includes(OSC133_ZONE_FINAL));
});
