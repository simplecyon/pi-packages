import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CompactDiffComponent, compactDiffLines } from "../src/diff.ts";

const distantChanges = [
	" 1 first context",
	"-2 const oldA = true;",
	"+2 const newA = true;",
	" 3 nearby context",
	" 4 hidden middle",
	" 5 nearby context",
	"-6 const oldB = true;",
	"+6 const newB = true;",
	" 7 final context",
].join("\n");

test("compact diff keeps one context line and collapses the middle", () => {
	assert.deepEqual(compactDiffLines(distantChanges), [
		{ kind: "context", text: " 1 first context" },
		{ kind: "removed", text: "-2 const oldA = true;" },
		{ kind: "added", text: "+2 const newA = true;" },
		{ kind: "context", text: " 3 nearby context" },
		{ kind: "omission", text: "  …" },
		{ kind: "context", text: " 5 nearby context" },
		{ kind: "removed", text: "-6 const oldB = true;" },
		{ kind: "added", text: "+6 const newB = true;" },
		{ kind: "context", text: " 7 final context" },
	]);
});

function semanticTheme(variant: "dark" | "light"): Theme {
	return {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		bg(color: string, text: string) {
			return `<bg:${color}>${text}</bg:${color}>`;
		},
		getFgAnsi(color: string) {
			if (variant === "light") {
				return color === "toolDiffAdded" ? "\x1b[38;2;88;132;88m" : "\x1b[38;2;170;85;85m";
			}
			return color === "toolDiffAdded" ? "\x1b[38;2;126;231;135m" : "\x1b[38;2;255;123;114m";
		},
		getBgAnsi() {
			return variant === "light" ? "\x1b[48;2;208;208;224m" : "\x1b[48;2;58;58;74m";
		},
		getColorMode() {
			return "truecolor";
		},
	} as unknown as Theme;
}

test("compact diff uses low-luminance semantic backgrounds in dark themes", () => {
	const rendered = new CompactDiffComponent(distantChanges, semanticTheme("dark")).render();

	assert.ok(
		rendered.some(
			(line) =>
				line ===
				"\x1b[48;2;74;45;48m<toolDiffRemoved>-2 </toolDiffRemoved><text>const oldA = true;</text>\x1b[49m",
		),
	);
	assert.ok(
		rendered.some(
			(line) =>
				line ===
				"\x1b[48;2;46;69;53m<toolDiffAdded>+2 </toolDiffAdded><text>const newA = true;</text>\x1b[49m",
		),
	);
	assert.ok(rendered.includes("<dim>  …</dim>"));
});

test("compact diff uses high-luminance semantic backgrounds in light themes", () => {
	const rendered = new CompactDiffComponent(distantChanges, semanticTheme("light")).render();

	assert.ok(
		rendered.some(
			(line) =>
				line ===
				"\x1b[48;2;232;222;227m<toolDiffRemoved>-2 </toolDiffRemoved><text>const oldA = true;</text>\x1b[49m",
		),
	);
	assert.ok(
		rendered.some(
			(line) =>
				line ===
				"\x1b[48;2;223;228;227m<toolDiffAdded>+2 </toolDiffAdded><text>const newA = true;</text>\x1b[49m",
		),
	);
});
