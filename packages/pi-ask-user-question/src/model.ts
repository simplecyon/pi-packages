import { visibleWidth } from "@earendil-works/pi-tui";
import type { AskUserQuestionParams, Question, QuestionAnswer } from "./types.ts";

const RESERVED_OTHER = /^other(?:\.\.\.|…)?$/iu;

export function validateParams(params: AskUserQuestionParams): string | undefined {
	if (params.questions.length < 1 || params.questions.length > 4) {
		return "questions must contain 1-4 items";
	}
	for (const [questionIndex, question] of params.questions.entries()) {
		if (!question.question.trim()) return `question ${questionIndex + 1} is empty`;
		if (!question.header.trim()) return `question ${questionIndex + 1} has an empty header`;
		if (visibleWidth(question.header) > 12) {
			return `question ${questionIndex + 1} header exceeds 12 terminal columns`;
		}
		if (question.options.length < 2 || question.options.length > 4) {
			return `question ${questionIndex + 1} must contain 2-4 options`;
		}
		const labels = new Set<string>();
		for (const option of question.options) {
			const label = option.label.trim();
			if (!label) return `question ${questionIndex + 1} contains an empty option label`;
			const normalized = label.toLocaleLowerCase();
			if (labels.has(normalized)) {
				return `question ${questionIndex + 1} contains duplicate option '${label}'`;
			}
			labels.add(normalized);
			if (RESERVED_OTHER.test(label)) {
				return "do not include Other; the UI adds it automatically";
			}
			if (question.multiSelect && option.preview !== undefined) {
				return "preview is only supported for single-select questions";
			}
		}
	}
	return undefined;
}

export function nextQuestionIndex(
	current: number,
	questions: readonly Question[],
	answers: ReadonlyMap<number, QuestionAnswer>,
): number {
	for (let offset = 1; offset <= questions.length; offset += 1) {
		const candidate = (current + offset) % questions.length;
		if (!answers.has(candidate)) return candidate;
	}
	return questions.length;
}

export function orderedAnswers(answers: ReadonlyMap<number, QuestionAnswer>): QuestionAnswer[] {
	return [...answers.values()].sort((left, right) => left.questionIndex - right.questionIndex);
}

export function answerSummary(answer: QuestionAnswer): string {
	const selected = answer.selectedLabels.join(", ");
	if (!answer.customText) return selected;
	return selected ? `${selected}, ${answer.customText}` : answer.customText;
}
