import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { answerSummary, nextQuestionIndex, orderedAnswers } from "./model.ts";
import type { Question, QuestionAnswer } from "./types.ts";

export interface DialogResult {
	cancelled: boolean;
	answers: QuestionAnswer[];
}

interface TUIHandle {
	readonly terminal: { readonly rows: number };
	requestRender(): void;
}

export class AskUserQuestionDialog {
	private readonly questions: Question[];
	private readonly theme: Theme;
	private readonly done: (result: DialogResult) => void;
	private readonly tui: TUIHandle;
	private readonly editor: Editor;
	private readonly answers = new Map<number, QuestionAnswer>();
	private readonly multiSelections = new Map<number, Set<number>>();
	private currentTab = 0;
	private optionIndex = 0;
	private inputMode = false;
	private pendingEscape = false;
	private cachedLines: string[] | undefined;

	constructor(
		questions: readonly Question[],
		tui: TUIHandle,
		theme: Theme,
		done: (result: DialogResult) => void,
	) {
		this.questions = [...questions];
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui as never, editorTheme);
		this.editor.onSubmit = (value) => this.saveOther(value.trim());
	}

	private refresh(): void {
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private question(): Question {
		return this.questions[Math.min(this.currentTab, this.questions.length - 1)]!;
	}

	private optionCount(): number {
		return this.question().options.length + 1;
	}

	private otherFocused(): boolean {
		return (
			this.currentTab < this.questions.length &&
			this.optionIndex === this.question().options.length
		);
	}

	private syncEditorFocus(): void {
		const focused = this.otherFocused();
		this.editor.focused = focused;
		if (focused) {
			this.editor.setText(this.answers.get(this.currentTab)?.customText ?? "");
		}
	}

	private moveToNext(): void {
		this.currentTab = nextQuestionIndex(this.currentTab, this.questions, this.answers);
		this.optionIndex = 0;
		this.inputMode = false;
		this.editor.focused = false;
		this.pendingEscape = false;
		this.refresh();
	}

	private saveSingle(label: string, customText?: string): void {
		const question = this.question();
		this.answers.set(this.currentTab, {
			questionIndex: this.currentTab,
			question: question.question,
			selectedLabels: customText ? [] : [label],
			...(customText ? { customText } : {}),
		});
		this.moveToNext();
	}

	private saveMulti(): void {
		const question = this.question();
		const selection = this.multiSelections.get(this.currentTab) ?? new Set<number>();
		const labels = [...selection]
			.sort((left, right) => left - right)
			.map((index) => question.options[index]?.label)
			.filter((label): label is string => Boolean(label));
		const previous = this.answers.get(this.currentTab);
		if (labels.length === 0 && !previous?.customText) return;
		this.answers.set(this.currentTab, {
			questionIndex: this.currentTab,
			question: question.question,
			selectedLabels: labels,
			...(previous?.customText ? { customText: previous.customText } : {}),
		});
		this.moveToNext();
	}

	private saveOther(value: string): void {
		if (!value) return;
		this.inputMode = false;
		this.editor.setText("");
		if (!this.question().multiSelect) {
			this.saveSingle("Other", value);
			return;
		}
		const previous = this.answers.get(this.currentTab);
		this.answers.set(this.currentTab, {
			questionIndex: this.currentTab,
			question: this.question().question,
			selectedLabels: previous?.selectedLabels ?? [],
			customText: value,
		});
		this.refresh();
	}

	private submit(): void {
		if (this.answers.size !== this.questions.length) {
			this.currentTab = nextQuestionIndex(this.questions.length - 1, this.questions, this.answers);
			this.refresh();
			return;
		}
		this.done({ cancelled: false, answers: orderedAnswers(this.answers) });
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.editor.setText(this.answers.get(this.currentTab)?.customText ?? "");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.pendingEscape) {
				this.done({ cancelled: true, answers: [] });
				return;
			}
			this.pendingEscape = true;
			this.refresh();
			return;
		}
		this.pendingEscape = false;

		const tabCount = this.questions.length + 1;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.currentTab = (this.currentTab + 1) % tabCount;
			this.optionIndex = 0;
			this.inputMode = false;
			this.editor.focused = false;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.currentTab = (this.currentTab - 1 + tabCount) % tabCount;
			this.optionIndex = 0;
			this.inputMode = false;
			this.editor.focused = false;
			this.refresh();
			return;
		}
		if (this.currentTab === this.questions.length) {
			if (matchesKey(data, Key.enter)) this.submit();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.optionIndex = (this.optionIndex - 1 + this.optionCount()) % this.optionCount();
			this.inputMode = false;
			this.syncEditorFocus();
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = (this.optionIndex + 1) % this.optionCount();
			this.inputMode = false;
			this.syncEditorFocus();
			this.refresh();
			return;
		}

		const question = this.question();
		const otherSelected = this.optionIndex === question.options.length;
		if (matchesKey(data, Key.space) && question.multiSelect && !otherSelected) {
			const selected = this.multiSelections.get(this.currentTab) ?? new Set<number>();
			if (selected.has(this.optionIndex)) selected.delete(this.optionIndex);
			else selected.add(this.optionIndex);
			this.multiSelections.set(this.currentTab, selected);
			this.refresh();
			return;
		}
		if (otherSelected && !matchesKey(data, Key.enter)) {
			this.inputMode = true;
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		if (otherSelected) {
			this.inputMode = true;
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (question.multiSelect) {
			this.saveMulti();
			return;
		}
		this.saveSingle(question.options[this.optionIndex]!.label);
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;
		const margin = 1;
		const safeWidth = Math.max(1, width - margin * 2);
		const otherFocused = this.otherFocused();
		const lines: string[] = [];
		const wrap = (text: string, indent = "") => {
			for (const [index, line] of wrapTextWithAnsi(text, Math.max(1, safeWidth - indent.length)).entries()) {
				lines.push(`${index === 0 ? indent : " ".repeat(indent.length)}${line}`);
			}
		};
		const tabs = [
			...this.questions.map((question, index) => {
				const marker = this.answers.has(index) ? "✓" : String(index + 1);
				const text = `[${marker} ${question.header}]`;
				return index === this.currentTab ? this.theme.fg("accent", text) : this.theme.fg("dim", text);
			}),
			this.currentTab === this.questions.length
				? this.theme.fg("accent", "[Submit]")
				: this.theme.fg("dim", "[Submit]"),
		];
		lines.push(this.theme.fg("accent", "─".repeat(safeWidth)));
		wrap(tabs.join(" "));
		lines.push("");

		if (this.currentTab === this.questions.length) {
			wrap(this.theme.fg("text", "Review answers"));
			lines.push("");
			for (const [index, question] of this.questions.entries()) {
				const answer = this.answers.get(index);
				wrap(
					`${this.theme.fg("muted", `${question.header}:`)} ${
						answer
							? this.theme.fg("text", answerSummary(answer))
							: this.theme.fg("warning", "Not answered")
					}`,
					"  ",
				);
			}
			lines.push("");
			wrap(
				this.answers.size === this.questions.length
					? this.theme.fg("accent", "Enter to submit")
					: this.theme.fg("warning", "Answer every question before submitting"),
			);
		} else {
			const question = this.question();
			wrap(this.theme.fg("text", question.question));
			lines.push("");
			const selectedMulti = this.multiSelections.get(this.currentTab) ?? new Set<number>();
			for (const [index, option] of question.options.entries()) {
				const focused = index === this.optionIndex;
				const selected = Boolean(question.multiSelect && selectedMulti.has(index));
				const marker = question.multiSelect ? (selected ? "[x]" : "[ ]") : focused ? "●" : "○";
				const prefix = focused ? this.theme.fg("accent", "› ") : "  ";
				wrap(`${prefix}${this.theme.fg(focused ? "accent" : "text", `${marker} ${option.label}`)}`);
				wrap(this.theme.fg("muted", option.description), "      ");
			}
			const otherFocused = this.optionIndex === question.options.length;
			wrap(
				`${otherFocused ? this.theme.fg("accent", "› ") : "  "}${this.theme.fg(
					otherFocused ? "accent" : "text",
					"○ Other...",
				)}`,
			);
			wrap(
				this.theme.fg("muted", this.answers.get(this.currentTab)?.customText ?? "Type a custom answer."),
				"      ",
			);
			const preview = question.options[this.optionIndex]?.preview;
			if (preview) {
				lines.push("");
				wrap(this.theme.fg("dim", "Preview"));
				for (const line of preview.split("\n")) wrap(this.theme.fg("text", line), "  ");
			}
			if (otherFocused) {
				lines.push("");
				wrap(this.theme.fg("muted", "Your answer:"));
				for (const line of this.editor.render(Math.max(1, safeWidth - 2))) lines.push(`  ${line}`);
			}
		}
		lines.push("");
		wrap(
			this.pendingEscape
				? this.theme.fg("warning", "Press Esc again to cancel")
				: this.theme.fg(
						"dim",
						otherFocused
							? "Type directly · Enter submit · Esc back"
							: "↑↓ move · Enter select/continue · Space toggle · Tab questions · Esc cancel",
					),
		);
		lines.push(this.theme.fg("accent", "─".repeat(safeWidth)));
		const leftPad = " ".repeat(margin);
		this.cachedLines = lines.map((line) => truncateToWidth(`${leftPad}${line}`, width));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}
}
