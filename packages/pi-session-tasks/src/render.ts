import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	isTaskReadDetails,
	isTaskToolDetails,
	type RenamedTaskChange,
	type RemovedTaskChange,
	type Task,
	type TaskChanges,
	type TaskUIState,
} from "./model.ts";

function taskIcon(task: Task, theme: Theme): string {
	if (task.status === "completed") return theme.fg("success", "✓");
	if (task.status === "in_progress") return theme.fg("accent", "●");
	return theme.fg("muted", "○");
}

function taskTitle(task: Task, theme: Theme): string {
	if (task.status === "completed") {
		return theme.fg("dim", theme.strikethrough(task.title));
	}
	if (task.status === "in_progress") return theme.fg("text", task.title);
	return theme.fg("muted", task.title);
}

function completedCount(tasks: readonly Task[]): number {
	return tasks.filter((task) => task.status === "completed").length;
}

function visibleTasks(tasks: readonly Task[]): { tasks: Task[]; hidden: number } {
	if (tasks.length <= 5) return { tasks: [...tasks], hidden: 0 };

	const currentIndex = tasks.findIndex((task) => task.status === "in_progress");
	const indexes = new Set<number>();
	const lastCompletedIndex = tasks.findLastIndex((task) => task.status === "completed");
	if (lastCompletedIndex >= 0) indexes.add(lastCompletedIndex);
	if (currentIndex >= 0) indexes.add(currentIndex);

	for (let index = Math.max(0, currentIndex + 1); index < tasks.length && indexes.size < 5; index += 1) {
		indexes.add(index);
	}
	for (let index = 0; index < tasks.length && indexes.size < 5; index += 1) {
		indexes.add(index);
	}

	const selected = [...indexes].sort((a, b) => a - b).map((index) => tasks[index]).filter(Boolean) as Task[];
	return { tasks: selected, hidden: tasks.length - selected.length };
}

export class TaskWidgetComponent {
	private readonly tasks: Task[];
	private readonly state: TaskUIState;
	private readonly theme: Theme;

	constructor(tasks: readonly Task[], state: TaskUIState, theme: Theme) {
		this.tasks = [...tasks];
		this.state = state;
		this.theme = theme;
	}

	render(width: number): string[] {
		const done = completedCount(this.tasks);
		if (this.state === "completed") {
			return [truncateToWidth(this.theme.fg("success", `✓ Tasks completed · ${done}/${this.tasks.length}`), width)];
		}

		const heading =
			this.state === "paused"
				? this.theme.fg("warning", `⏸ Tasks paused · ${done}/${this.tasks.length}`)
				: this.theme.fg("accent", `Tasks · ${done}/${this.tasks.length}`);
		const selection = visibleTasks(this.tasks);
		const lines = [truncateToWidth(heading, width)];

		for (const task of selection.tasks) {
			lines.push(truncateToWidth(`${taskIcon(task, this.theme)} ${taskTitle(task, this.theme)}`, width));
		}
		if (selection.hidden > 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", `… ${selection.hidden} more`), width));
		}
		return lines;
	}

	invalidate(): void {}
}

export class TaskListComponent {
	private readonly tasks: Task[];
	private readonly state: TaskUIState;
	private readonly theme: Theme;
	private readonly onClose: () => void;

	constructor(tasks: readonly Task[], state: TaskUIState, theme: Theme, onClose: () => void) {
		this.tasks = [...tasks];
		this.state = state;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		const done = completedCount(this.tasks);
		const stateLabel = this.state === "paused" ? "paused" : this.state === "completed" ? "completed" : "running";
		const lines = [
			"",
			truncateToWidth(this.theme.fg("accent", ` Tasks · ${stateLabel} · ${done}/${this.tasks.length} `), width),
			"",
		];

		if (this.tasks.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", " No tasks in this session."), width));
		} else {
			for (const task of this.tasks) {
				lines.push(
					truncateToWidth(
						` ${taskIcon(task, this.theme)} ${this.theme.fg("accent", task.id)}  ${taskTitle(task, this.theme)}`,
						width,
					),
				);
			}
		}

		lines.push("", truncateToWidth(this.theme.fg("dim", " Press Escape to close"), width), "");
		return lines;
	}

	invalidate(): void {}
}

function taskById(tasks: readonly Task[], id: string): Task | undefined {
	return tasks.find((task) => task.id === id);
}

function changeLines(changes: TaskChanges, tasks: readonly Task[], theme: Theme): string[] {
	const lines: string[] = [];
	const add = (icon: string, label: string, ids: readonly string[], color: "success" | "accent" | "warning" | "muted") => {
		for (const id of ids) {
			const title = taskById(tasks, id)?.title ?? id;
			lines.push(`${theme.fg(color, icon)} ${theme.fg("muted", `${label}  ${title}`)}`);
		}
	};

	add("✓", "Completed", changes.completed, "success");
	add("●", "Started", changes.started, "accent");
	add(
		"+",
		"Added",
		changes.added.filter((id) => !changes.started.includes(id) && !changes.completed.includes(id)),
		"accent",
	);
	add("↻", "Reopened", changes.reopened, "warning");
	for (const change of changes.renamed) {
		if (typeof change === "string") {
			const title = taskById(tasks, change)?.title ?? change;
			lines.push(`${theme.fg("muted", "✎")} ${theme.fg("muted", `Title changed  ${title}`)}`);
			continue;
		}
		const renamed = change as RenamedTaskChange;
		lines.push(
			`${theme.fg("muted", "✎")} ${theme.fg("muted", `Title changed  ${renamed.from} → ${renamed.to}`)}`,
		);
	}
	for (const change of changes.removed) {
		const removed: RemovedTaskChange =
			typeof change === "string" ? { id: change, title: change } : change;
		lines.push(`${theme.fg("muted", "−")} ${theme.fg("muted", `Removed  ${removed.title}`)}`);
	}
	if (changes.reordered) lines.push(theme.fg("muted", "↕ Reordered tasks"));
	return lines;
}

function fallbackResultText(
	result: { content: Array<{ type: string; text?: string }> },
): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function compactValidationError(text: string): string | undefined {
	if (!text.startsWith('Validation failed for tool "update_tasks":')) return undefined;
	const firstIssue = text.match(/^\s*-\s+(.+)$/m)?.[1]?.trim();
	return `Task update rejected · ${firstIssue || "invalid arguments"}`;
}

export function renderToolCall(
	args: { tasks?: unknown; expected_revision?: unknown },
	theme: Theme,
): Text {
	const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
	return new Text(
		theme.fg("muted", "•") +
			" " +
			theme.fg("toolTitle", "Update Tasks") +
			theme.fg("muted", ` (${count} task${count === 1 ? "" : "s"})`),
		0,
		0,
	);
}

export function renderToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: Theme,
	expanded: boolean,
): Text {
	if (!isTaskToolDetails(result.details)) {
		const fallback = fallbackResultText(result);
		const validationError = compactValidationError(fallback);
		if (!expanded && validationError) {
			return new Text(theme.fg("error", validationError), 0, 0);
		}
		return new Text(fallback, 0, 0);
	}
	if (!expanded) return new Text("", 0, 0);
	const details = result.details;
	if (details.unchanged) return new Text(theme.fg("dim", "Tasks unchanged"), 0, 0);
	if (details.tasks.length === 0) return new Text(theme.fg("success", "✓ Task list cleared"), 0, 0);

	const lines = changeLines(details.changes, details.tasks, theme);
	if (lines.length === 0) {
		const done = completedCount(details.tasks);
		lines.push(theme.fg("muted", `Tasks updated · ${done}/${details.tasks.length}`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

export function renderReadToolCall(theme: Theme): Text {
	return new Text(
		theme.fg("muted", "•") + " " + theme.fg("toolTitle", "Get Tasks"),
		0,
		0,
	);
}

export function renderReadToolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: Theme,
	expanded: boolean,
): Text {
	if (!isTaskReadDetails(result.details)) return new Text(fallbackResultText(result), 0, 0);
	if (!expanded) return new Text("", 0, 0);
	const details = result.details;
	if (details.tasks.length === 0) {
		return new Text(theme.fg("dim", `No tasks · revision ${details.revision}`), 0, 0);
	}

	const done = completedCount(details.tasks);
	return new Text(
		theme.fg("muted", `Tasks · ${done}/${details.tasks.length} completed · revision ${details.revision}`),
		0,
		0,
	);
}
