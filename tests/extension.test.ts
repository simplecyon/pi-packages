import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import minimalTuiExtension, { createMinimalToolDefinitions } from "../src/index.ts";

test("registers all built-in tools with self-rendered shells", () => {
	const tools: Array<{ name: string; renderShell?: string }> = [];
	const pi = {
		registerTool(tool: { name: string; renderShell?: string }) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	minimalTuiExtension(pi);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["read", "bash", "edit", "write", "grep", "find", "ls"],
	);
	assert.ok(tools.every((tool) => tool.renderShell === "self"));
});

test("decorated read definition renders a real compact call and honors expanded output", () => {
	const read = createMinimalToolDefinitions(process.cwd()).find((tool) => tool.name === "read") as ToolDefinition;
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as Theme;
	const state = {};
	const baseContext = {
		args: { path: "README.md" },
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
	};

	const call = read.renderCall?.({ path: "README.md" }, theme, baseContext as any);
	assert.deepEqual(call?.render(80), ["·read README.md"]);

	const collapsedResult = read.renderResult?.(
		{ content: [{ type: "text", text: "line one\nline two" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...baseContext, lastComponent: undefined } as any,
	);
	assert.deepEqual(collapsedResult?.render(80), []);

	const expandedResult = read.renderResult?.(
		{ content: [{ type: "text", text: "line one\nline two" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{ ...baseContext, expanded: true, lastComponent: collapsedResult } as any,
	);
	assert.deepEqual(expandedResult?.render(80), ["  line one", "  line two"]);
});

test("all decorated built-ins produce one background-free collapsed summary row", () => {
	initTheme("dark");
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return `\x1b[48;2;1;2;3m${text}\x1b[49m`;
		},
		bold(text: string) {
			return text;
		},
	} as Theme;
	const cases = [
		["read", { path: "README.md" }, "·read README.md"],
		["bash", { command: "npm test" }, "·bash npm test"],
		["edit", { path: "src/index.ts", oldText: "a", newText: "b" }, "·edit src/index.ts"],
		["write", { path: "src/new.ts", content: "" }, "·write src/new.ts"],
		["grep", { pattern: "renderShell", path: "src" }, "·grep \"renderShell\" in src"],
		["find", { pattern: "*.ts", path: "src" }, "·find \"*.ts\" in src"],
		["ls", { path: "src" }, "·ls src"],
	] as const;

	for (const [name, args, expected] of cases) {
		const definition = createMinimalToolDefinitions(process.cwd()).find((tool) => tool.name === name) as ToolDefinition;
		const call = definition.renderCall?.(args as any, theme, {
			args,
			toolCallId: `call-${name}`,
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: false,
			argsComplete: false,
			isPartial: true,
			expanded: false,
			showImages: true,
			isError: false,
		} as any);
		assert.deepEqual(call?.render(100), [expected], name);
	}
});
