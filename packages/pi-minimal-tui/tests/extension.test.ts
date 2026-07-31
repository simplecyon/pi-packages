import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ActionGroupCoordinator } from "../src/grouping.ts";
import minimalTuiExtension, {
	addDefaultBashTimeout,
	createMinimalToolDefinitions,
	DEFAULT_BASH_TIMEOUT_SECONDS,
} from "../src/index.ts";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function plain(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

test("registers all built-in tools with self-rendered shells", () => {
	const tools: Array<{ name: string; renderShell?: string }> = [];
	const pi = {
		on() {},
		events: {
			on() {
				return () => {};
			},
			emit() {},
		},
		registerTool(tool: { name: string; renderShell?: string }) {
			tools.push(tool);
		},
		registerEntryRenderer() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;

	minimalTuiExtension(pi);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["read", "bash", "edit", "write", "grep", "find", "ls"],
	);
	assert.ok(tools.every((tool) => tool.renderShell === "self"));
});

test("injects a finite Bash timeout without overriding an explicit value", () => {
	const definitions = createMinimalToolDefinitions(process.cwd());
	const bash = definitions.find((tool) => tool.name === "bash") as ToolDefinition;
	assert.deepEqual(
		bash.prepareArguments?.({ command: "git status" }),
		{ command: "git status", timeout: DEFAULT_BASH_TIMEOUT_SECONDS },
	);
	assert.deepEqual(
		bash.prepareArguments?.({ command: "npm test", timeout: 120 }),
		{ command: "npm test", timeout: 120 },
	);

	const read = definitions.find((tool) => tool.name === "read") as ToolDefinition;
	assert.equal(addDefaultBashTimeout(read), read);
});

test("forwards Bash partial and final output through the safety redaction bridge", async () => {
	const tools = new Map<string, ToolDefinition>();
	const secret = ["xoxb", "1234567890", "minimalbridge"].join("-");
	const pi = {
		on() {},
		events: {
			on() {
				return () => {};
			},
			emit(channel: string, request: { value?: unknown }) {
				if (channel !== "simplecyon:safe-operation:redact") return;
				request.value = JSON.parse(
					JSON.stringify(request.value).split(secret).join("<redacted:bridge>"),
				);
			},
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerEntryRenderer() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	minimalTuiExtension(pi);
	const bash = tools.get("bash");
	assert.ok(bash);

	const updates: unknown[] = [];
	const result = await bash.execute(
		"bash-redaction-bridge",
		{ command: `printf 'TOKEN=${secret}'` },
		undefined,
		(partial: unknown) => updates.push(partial as any),
		{
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "minimal-tui-test-session",
				getSessionFile: () => undefined,
			},
			model: undefined,
			thinkingLevel: undefined,
		} as any,
	);
	const serialized = JSON.stringify({ updates, result });
	assert.doesNotMatch(serialized, new RegExp(secret));
	assert.match(serialized, /<redacted:bridge>/);
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
	assert.deepEqual(call?.render(80), ["• Read (README.md)"]);

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
		["read", { path: "README.md" }, "• Read (README.md)"],
		["bash", { command: "npm test" }, "• Bash (npm test)"],
		["edit", { path: "src/index.ts", oldText: "a", newText: "b" }, "• Edit (index.ts)"],
		["write", { path: "src/new.ts", content: "" }, "• Write (new.ts)"],
		["grep", { pattern: "renderShell", path: "src" }, "• Grep (renderShell)"],
		["find", { pattern: "*.ts", path: "src" }, "• Find (*.ts)"],
		["ls", { path: "src" }, "• List (src)"],
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

test("collapsed mixed actions render only one aggregate row", () => {
	initTheme("dark");
	const grouping = new ActionGroupCoordinator();
	grouping.recordTool("call-bash", "bash");
	grouping.recordTool("call-read", "read");
	const definitions = createMinimalToolDefinitions(process.cwd(), grouping);
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as Theme;

	function renderCall(name: string, toolCallId: string, args: Record<string, unknown>) {
		const definition = definitions.find((tool) => tool.name === name) as ToolDefinition;
		return definition.renderCall?.(args, theme, {
			args,
			toolCallId,
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
		} as any);
	}

	const bash = renderCall("bash", "call-bash", { command: "npm test" });
	const read = renderCall("read", "call-read", { path: "README.md" });
	assert.deepEqual(bash?.render(100), []);
	assert.deepEqual(read?.render(100), ["• Read 1 file, ran 1 bash"]);
});

test("bash timeout stays collapsed and annotates the call summary", () => {
	initTheme("dark");
	const bash = createMinimalToolDefinitions(process.cwd()).find((tool) => tool.name === "bash") as ToolDefinition;
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
		args: { command: "npm run dev" },
		toolCallId: "call-timeout",
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
	const call = bash.renderCall?.(baseContext.args, theme, baseContext as any);
	const result = bash.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: "vite building\\ntransforming...\\n\\nCommand timed out after 30 seconds",
				},
			],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ ...baseContext, lastComponent: undefined, isError: true } as any,
	);

	assert.deepEqual(call?.render(80), ["• Bash (npm run dev) × timeout 30s"]);
	assert.deepEqual(result?.render(80), []);
});

test("a completed edit uses the compact diff while collapsed", async () => {
	initTheme("dark");
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-edit-"));
	try {
		await writeFile(join(cwd, "sample.ts"), "const value = 1;\n", "utf8");
		const edit = createMinimalToolDefinitions(cwd).find((tool) => tool.name === "edit") as ToolDefinition;
		const args = {
			path: "sample.ts",
			edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
		};
		const theme = {
			fg(_color: string, text: string) {
				return text;
			},
			bg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		} as Theme;
		let resolveInvalidation: (() => void) | undefined;
		const invalidated = new Promise<void>((resolve) => {
			resolveInvalidation = resolve;
		});
		const state = {};
		const context = {
			args,
			toolCallId: "call-edit",
			invalidate() {
				resolveInvalidation?.();
			},
			lastComponent: undefined,
			state,
			cwd,
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
		};
		const component = edit.renderCall?.(args, theme, context as any);
		await invalidated;
		const updated = edit.renderCall?.(args, theme, { ...context, lastComponent: component } as any);
		assert.deepEqual(updated?.render(100), ["• Edit (sample.ts)"]);

		const result = edit.renderResult?.(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in sample.ts." }],
				details: {
					diff: "-1 const value = 1;\n+1 const value = 2;",
					firstChangedLine: 1,
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, lastComponent: undefined } as any,
		);
		const rendered = result?.render(100) ?? [];
		assert.deepEqual(rendered.map((line) => plain(line).trimEnd()), [
			"  -1 const value = 1;",
			"  +1 const value = 2;",
		]);
		assert.ok(rendered.every((line) => plain(line).length === 100));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
