import assert from "node:assert/strict";
import test from "node:test";
import { answerSummary, nextQuestionIndex, orderedAnswers, validateParams } from "../src/model.ts";
import type { QuestionAnswer } from "../src/types.ts";

const questions = [
	{
		header: "Scope",
		question: "Which scope?",
		options: [
			{ label: "Local", description: "Current project." },
			{ label: "Global", description: "Every project." },
		],
	},
	{
		header: "Style",
		question: "Which style?",
		options: [
			{ label: "Compact", description: "Less output." },
			{ label: "Detailed", description: "More context." },
		],
	},
];

test("validates limits and reserved Other labels", () => {
	assert.equal(validateParams({ questions }), undefined);
	assert.equal(validateParams({ questions: [] }), "questions must contain 1-4 items");
	assert.match(
		validateParams({
			questions: [
				{
					...questions[0],
					options: [...questions[0].options, { label: "Other...", description: "Duplicate." }],
				},
			],
		}) ?? "",
		/do not include Other/,
	);
});

test("rejects preview for multi-select questions", () => {
	assert.equal(
		validateParams({
			questions: [
				{
					...questions[0],
					multiSelect: true,
					options: [
						{ ...questions[0].options[0], preview: "preview" },
						questions[0].options[1],
					],
				},
			],
		}),
		"preview is only supported for single-select questions",
	);
});

test("finds unanswered questions and orders answer results", () => {
	const answers = new Map<number, QuestionAnswer>([
		[1, { questionIndex: 1, question: "Which style?", selectedLabels: ["Compact"] }],
	]);
	assert.equal(nextQuestionIndex(1, questions, answers), 0);
	answers.set(0, {
		questionIndex: 0,
		question: "Which scope?",
		selectedLabels: [],
		customText: "Workspace",
	});
	assert.equal(nextQuestionIndex(0, questions, answers), 2);
	assert.deepEqual(orderedAnswers(answers).map((answer) => answer.questionIndex), [0, 1]);
	assert.equal(answerSummary(answers.get(0)!), "Workspace");
});
