export const EXCLUSIVE_UI_CHANNEL = "simplecyon:ui-exclusive";

export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface AskUserQuestionParams {
	questions: Question[];
	metadata?: { source?: string };
}

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	selectedLabels: string[];
	customText?: string;
}

export interface AskUserQuestionDetails {
	schemaVersion: 1;
	status: "answered" | "cancelled" | "unavailable";
	answers: QuestionAnswer[];
	metadata?: { source?: string };
	reason?: string;
}

export interface ExclusiveUIEvent {
	action: "acquire" | "release";
	token: string;
	source: string;
}

export function isExclusiveUIEvent(value: unknown): value is ExclusiveUIEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<ExclusiveUIEvent>;
	return (
		(event.action === "acquire" || event.action === "release") &&
		typeof event.token === "string" &&
		event.token.length > 0 &&
		typeof event.source === "string" &&
		event.source.length > 0
	);
}
