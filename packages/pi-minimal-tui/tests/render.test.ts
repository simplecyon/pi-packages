import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { MinimalToolCallComponent, MinimalToolResultComponent, renderedWidth, stripBackgroundAnsi } from "../src/render.ts";

const theme = {
	fg(_color: string, text: string) {
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
		{ verb: "read", detail: "docs: extensions.md" },
		new StaticComponent(["read /long/path/extensions.md", "", "content"]),
		false,
		theme,
	);
	assert.deepEqual(component.render(80), ["·read docs: extensions.md"]);
});

test("expanded state restores an item hidden by its collapsed group", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "read", detail: "README.md" },
		new StaticComponent(["read README.md", "", "file contents"]),
		false,
		theme,
		{ getGroupView: () => ({ hidden: true }) },
	);
	assert.deepEqual(component.render(80), []);

	component.update(
		{ verb: "read", detail: "README.md" },
		new StaticComponent(["read README.md", "", "file contents"]),
		true,
		theme,
		{ getGroupView: () => ({ hidden: true }) },
	);
	assert.deepEqual(component.render(80), ["·read README.md", "  file contents"]);
});

test("expanded call keeps summary and indents original body", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "write", detail: "src/index.ts" },
		new StaticComponent(["\x1b[44mwrite src/index.ts\x1b[49m", "", "const value = 1;", ""]),
		true,
		theme,
	);
	assert.deepEqual(component.render(80), ["·write src/index.ts", "  const value = 1;"]);
});

test("edit calls can keep diff details visible while collapsed", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "edit", detail: "src/index.ts" },
		new StaticComponent(["edit src/index.ts", "", " 1 -const oldValue = 1;", " 1 +const newValue = 2;"]),
		false,
		theme,
		{ showInnerCollapsed: true },
	);
	assert.deepEqual(component.render(80), [
		"·edit src/index.ts",
		"   1 -const oldValue = 1;",
		"   1 +const newValue = 2;",
	]);
});

test("compact error status keeps priority over a long command", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "bash", detail: "a very long command that should be truncated before the outcome" },
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

test("rendered rows respect the requested width", () => {
	const component = new MinimalToolCallComponent(
		{ verb: "bash", detail: "a very long command that must be clipped" },
		undefined,
		false,
		theme,
	);
	const lines = component.render(24);
	assert.ok(renderedWidth(lines) <= 24);
});
