import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface ThemeFile {
	vars: Record<string, string>;
	colors: Record<string, string>;
}

test("highlights user messages without restoring event backgrounds", async () => {
	const path = new URL("../themes/cyon-minimal-dark.json", import.meta.url);
	const theme = JSON.parse(await readFile(path, "utf8")) as ThemeFile;

	assert.equal(theme.vars.text, "#ffffff");
	assert.equal(theme.vars.userMsgBg, "#343541");
	assert.equal(theme.colors.userMessageBg, "userMsgBg");
	assert.equal(theme.colors.userMessageText, "text");
	assert.equal(theme.colors.toolTitle, "text");
	assert.equal(theme.colors.customMessageBg, "");
	assert.equal(theme.colors.toolPendingBg, "");
	assert.equal(theme.colors.toolSuccessBg, "");
	assert.equal(theme.colors.toolErrorBg, "");
	assert.equal(theme.vars.diffGreen, "#7ee787");
	assert.equal(theme.vars.diffRed, "#ff7b72");
	assert.equal(theme.colors.toolDiffAdded, "diffGreen");
	assert.equal(theme.colors.toolDiffRemoved, "diffRed");
});
