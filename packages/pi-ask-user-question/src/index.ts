import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AskUserQuestionDialog } from "./dialog.ts";
import type { DialogResult } from "./dialog.ts";
import { answerSummary, validateParams } from "./model.ts";
import {
	EXCLUSIVE_UI_CHANNEL,
	type AskUserQuestionDetails,
	type AskUserQuestionParams,
	type Question,
	type QuestionAnswer,
} from "./types.ts";

const OptionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, description: "Short display label" }),
		description: Type.String({ minLength: 1, description: "Concise impact or trade-off" }),
		preview: Type.Optional(Type.String({ description: "Optional code, config, diagram, or ASCII preview" })),
	},
	{ additionalProperties: false },
);
const QuestionSchema = Type.Object(
	{
		header: Type.String({ minLength: 1, description: "Short navigation label, at most 12 terminal columns" }),
		question: Type.String({ minLength: 1, description: "Question shown to the user" }),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple options to be selected" })),
		options: Type.Array(OptionSchema, {
			minItems: 2,
			maxItems: 4,
			description: "Do not add Other; the UI adds it automatically",
		}),
	},
	{ additionalProperties: false },
);
const Parameters = Type.Object(
	{
		questions: Type.Array(QuestionSchema, {
			minItems: 1,
			maxItems: 4,
			description: "One blocking question, or a small batch of independent questions",
		}),
		metadata: Type.Optional(
			Type.Object({ source: Type.Optional(Type.String()) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

function content(details: AskUserQuestionDetails): string {
	if (details.status === "cancelled") return "User cancelled the questions.";
	if (details.status === "unavailable") {
		return `User input unavailable: ${details.reason ?? "no interactive UI"}`;
	}
	return details.answers
		.map((answer, index) => `Q${index + 1}: ${answer.question}\nA${index + 1}: ${answerSummary(answer)}`)
		.join("\n\n");
}

async function askSingleRPC(
	question: Question,
	questionIndex: number,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<QuestionAnswer | undefined> {
	if (!question.multiSelect) {
		const labels = [...question.options.map((option) => option.label), "Other..."];
		const selected = await ctx.ui.select(question.question, labels, { signal });
		if (selected === undefined) return undefined;
		if (selected !== "Other...") {
			return { questionIndex, question: question.question, selectedLabels: [selected] };
		}
		const customText = await ctx.ui.input(question.question, "Type your answer", { signal });
		if (customText === undefined) return undefined;
		return { questionIndex, question: question.question, selectedLabels: [], customText };
	}

	const selected = new Set<string>();
	let customText: string | undefined;
	while (true) {
		const choices = question.options.map(
			(option) => `${selected.has(option.label) ? "[x]" : "[ ]"} ${option.label}`,
		);
		choices.push(customText ? `[x] Other: ${customText}` : "[ ] Other...", "Done");
		const choice = await ctx.ui.select(question.question, choices, { signal });
		if (choice === undefined) return undefined;
		if (choice === "Done") {
			if (selected.size === 0 && !customText) continue;
			return {
				questionIndex,
				question: question.question,
				selectedLabels: [...selected],
				...(customText ? { customText } : {}),
			};
		}
		if (choice.includes("Other")) {
			const value = await ctx.ui.input(question.question, "Type your answer", { signal });
			if (value !== undefined) customText = value;
			continue;
		}
		const label = choice.replace(/^\[[ x]\]\s+/, "");
		if (selected.has(label)) selected.delete(label);
		else selected.add(label);
	}
}

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "Ask User Question",
		renderShell: "self",
		executionMode: "sequential",
		description:
			"Ask the user structured questions when a preference or missing requirement materially blocks progress. Do not use for dangerous-action confirmation, plan approval, or information inferable from context.",
		promptSnippet: "Ask the user structured blocking questions with options and previews",
		promptGuidelines: [
			"Use AskUserQuestion only when the user's preference or missing requirement materially changes the result.",
			"Do not use it for dangerous-action confirmation, plan approval, or facts you can infer from project context.",
			"Prefer one question at a time when later choices depend on earlier answers; batch only independent questions.",
			"Provide 2-4 concrete options, put the recommended option first with '(Recommended)' in its label, and explain the trade-off in its description.",
			"Do not add Other; the UI always provides it.",
			"Call AskUserQuestion by itself rather than alongside sibling tools so cancellation can return control to chat.",
		],
		parameters: Parameters,

		async execute(toolCallId, params: AskUserQuestionParams, signal, _onUpdate, ctx) {
			const validationError = validateParams(params);
			if (validationError) throw new Error(validationError);
			let details: AskUserQuestionDetails;

			if (ctx.mode === "print" || ctx.mode === "json" || !ctx.hasUI) {
				details = {
					schemaVersion: 1,
					status: "unavailable",
					answers: [],
					metadata: params.metadata,
					reason: `AskUserQuestion cannot collect input in ${ctx.mode} mode`,
				};
				return { content: [{ type: "text" as const, text: content(details) }], details };
			}

			if (ctx.mode === "rpc") {
				const answers: QuestionAnswer[] = [];
				for (const [index, question] of params.questions.entries()) {
					const answer = await askSingleRPC(question, index, ctx, signal);
					if (!answer) {
						details = {
							schemaVersion: 1,
							status: "cancelled",
							answers: [],
							metadata: params.metadata,
						};
						return {
							content: [{ type: "text" as const, text: content(details) }],
							details,
							terminate: true,
						};
					}
					answers.push(answer);
				}
				details = { schemaVersion: 1, status: "answered", answers, metadata: params.metadata };
				return { content: [{ type: "text" as const, text: content(details) }], details };
			}

			pi.events.emit(EXCLUSIVE_UI_CHANNEL, {
				action: "acquire",
				token: toolCallId,
				source: "AskUserQuestion",
			});
			ctx.ui.setWorkingVisible(false);
			try {
				const result = await ctx.ui.custom<DialogResult>((tui, theme, _keybindings, done) =>
					new AskUserQuestionDialog(params.questions, tui, theme, done),
				);
				details = {
					schemaVersion: 1,
					status: result.cancelled ? "cancelled" : "answered",
					answers: result.answers,
					metadata: params.metadata,
				};
				return {
					content: [{ type: "text" as const, text: content(details) }],
					details,
					...(result.cancelled ? { terminate: true } : {}),
				};
			} finally {
				ctx.ui.setWorkingVisible(true);
				pi.events.emit(EXCLUSIVE_UI_CHANNEL, {
					action: "release",
					token: toolCallId,
					source: "AskUserQuestion",
				});
			}
		},

		renderCall(args, theme) {
			const count = args.questions.length;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("AskUserQuestion"))} ${theme.fg(
					"muted",
					`${count} question${count === 1 ? "" : "s"}`,
				)}`,
				1,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) return new Text("", 1, 0);
			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", "Question cancelled"), 1, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "Question unavailable"), 1, 0);
			}
			return new Text(
				details.answers
					.map((answer) => `${theme.fg("success", "✓")} ${theme.fg("text", answerSummary(answer))}`)
					.join("\n"),
				1,
				0,
			);
		},
	});
}
