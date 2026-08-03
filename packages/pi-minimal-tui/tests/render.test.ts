import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	formatThoughtDuration,
	MinimalToolCallComponent,
	MinimalToolResultComponent,
	renderedWidth,
	stripBackgroundAnsi,
} from "../src/render.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as Theme;

class StaticComponent implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

test("strips standard and extended background SGR without removing foreground", () => {
	const source = "\x1b[31;48;2;10;20;30merror\x1b[49m \x1b[42mok\x1b[39m";
	const stripped = stripBackgroundAnsi(source);
	assert.equal(stripped, "\x1b[31merror ok\x1b[39m");
});

test("collapsed call renders one compact event row", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Read", detail: "extensions.md" },
		new StaticComponent(["read /long/path/extensions.md", "", "content"]),
		false,
		theme,
	);
	assert.deepEqual(component.render(80), ["• Read (extensions.md)"]);
});

test("auto approval follows the action row", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Edit", detail: "runtime-context.ts" },
		undefined,
		false,
		theme,
		{ approval: () => "auto approved" },
	);
	assert.deepEqual(component.render(80), ["• Edit (runtime-context.ts)", "- auto approved"]);
});

test("running group rows use branch markers", () => {
	const middle = new MinimalToolCallComponent({ verb: "Read", detail: "Layout.tsx" }, undefined, false, theme, {
		getGroupView: () => ({ hidden: false, marker: "middle" }),
	});
	const last = new MinimalToolCallComponent({ verb: "Grep", detail: "handleOpenPasswordDialog" }, undefined, false, theme, {
		getGroupView: () => ({ hidden: false, marker: "last" }),
	});

	assert.deepEqual(middle.render(80), ["⊢ Read (Layout.tsx)"]);
	assert.deepEqual(last.render(80), ["⨽ Grep (handleOpenPasswordDialog)"]);
});

test("completed group renders elapsed time above its aggregate", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Grep", detail: "password" },
		undefined,
		false,
		theme,
		{
			getGroupView: () => ({
				hidden: false,
				summary: { verb: "Read 1 file, searched 2 times" },
				marker: "last",
				elapsedMs: 30_000,
				separateFromMessage: true,
			}),
		},
	);

	assert.deepEqual(component.render(80), ["• Thought for 30s", "⨽ Read 1 file, searched 2 times", ""]);
	assert.equal(formatThoughtDuration(65_000), "1m 5s");
});

test("action event text uses the terminal medium-weight approximation", () => {
	const weightedTheme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return `<medium>${text}</medium>`;
		},
	} as Theme;
	const component = new MinimalToolCallComponent(
		{ verb: "Read", detail: "extensions.md" },
		undefined,
		false,
		weightedTheme,
	);

	assert.deepEqual(component.render(80), ["• <medium>Read (extensions.md)</medium>"]);
});

test("expanded state restores an item hidden by its collapsed group", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Read", detail: "README.md" },
		new StaticComponent(["read README.md", "", "file contents"]),
		false,
		theme,
		{ getGroupView: () => ({ hidden: true }) },
	);
	assert.deepEqual(component.render(80), []);

	component.update(
		{ verb: "Read", detail: "README.md" },
		new StaticComponent(["read README.md", "", "file contents"]),
		true,
		theme,
		{ getGroupView: () => ({ hidden: true }) },
	);
	assert.deepEqual(component.render(80), ["• Read (README.md)", "  file contents"]);
});

test("expanded call keeps summary and indents original body", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Write", detail: "index.ts" },
		new StaticComponent(["\x1b[44mwrite src/index.ts\x1b[49m", "", "const value = 1;", ""]),
		true,
		theme,
	);
	assert.deepEqual(component.render(80), ["• Write (index.ts)", "  const value = 1;"]);
});

test("edit calls can keep diff details visible while collapsed", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Edit", detail: "index.ts" },
		new StaticComponent(["edit src/index.ts", "", " 1 -const oldValue = 1;", " 1 +const newValue = 2;"]),
		false,
		theme,
		{ showInnerCollapsed: true },
	);
	assert.deepEqual(component.render(80), [
		"• Edit (index.ts)",
		"   1 -const oldValue = 1;",
		"   1 +const newValue = 2;",
	]);
});

test("compact error status keeps priority over a long command", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Bash", detail: "a very long command that should be truncated before the outcome" },
		undefined,
		false,
		theme,
		{ outcome: "timeout 30s" },
	);
	const [line = ""] = component.render(36);
	assert.match(line, /× timeout 30s$/);
	assert.ok(renderedWidth([line]) <= 36);
});

test("result stays hidden while collapsed except when caller marks it visible", () => {
	const inner = new StaticComponent(["output", "done"]);
	const component = new MinimalToolResultComponent(inner, false);
	assert.deepEqual(component.render(80), []);
	component.update(inner, true);
	assert.deepEqual(component.render(80), ["  output", "  done"]);
});

test("result preserves an explicitly allowed compact diff background", () => {
	const background = "\x1b[48;2;40;40;50m";
	const reset = "\x1b[49m";
	const inner = new StaticComponent([`${background}-1 old${reset}`, `${background}+1 new${reset}`]);
	const component = new MinimalToolResultComponent(inner, true, true);

	assert.deepEqual(component.render(80), [
		`${background}  -1 old${reset}`,
		`${background}  +1 new${reset}`,
	]);
});

test("rendered rows respect the requested width", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "Bash", detail: "a very long command that must be clipped" },
		undefined,
		false,
		theme,
	);
	const lines = component.render(24);
	assert.ok(renderedWidth(lines) <= 24);
});
