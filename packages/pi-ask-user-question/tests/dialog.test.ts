import assert from "node:assert/strict";
import test from "node:test";
import { AskUserQuestionDialog, type DialogResult } from "../src/dialog.ts";

const theme = {
	fg: (_color: string, value: string) => value,
};
const questions = [
	{
		header: "Layout",
		question: "Which layout?",
		options: [
			{
				label: "Compact (Recommended)",
				description: "Keep the terminal dense.",
				preview: "┌─ compact ─┐\n└───────────┘",
			},
			{ label: "Spacious", description: "Use more vertical rhythm." },
		],
	},
];

function createDialog(onDone: (result: DialogResult) => void) {
	return new AskUserQuestionDialog(
		questions,
		{ requestRender() {} },
		theme as never,
		onDone,
	);
}

test("renders the focused option preview", () => {
	const dialog = createDialog(() => {});
	assert.match(dialog.render(60).join("\n"), /compact/);
});

test("selects an answer, reviews it, and submits", () => {
	const results: DialogResult[] = [];
	const dialog = createDialog((value) => {
		results.push(value);
	});
	dialog.handleInput("\r");
	assert.equal(results.length, 0);
	dialog.handleInput("\r");
	assert.equal(results[0]?.cancelled, false);
	assert.deepEqual(results[0]?.answers[0]?.selectedLabels, ["Compact (Recommended)"]);
});

test("requires two consecutive Escape presses to cancel", () => {
	const results: DialogResult[] = [];
	const dialog = createDialog((value) => {
		results.push(value);
	});
	dialog.handleInput("\u001b");
	assert.equal(results.length, 0);
	dialog.handleInput("\u001b");
	assert.equal(results[0]?.cancelled, true);
});
