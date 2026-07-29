export const MAX_TASKS = 12;
export const MAX_TASK_ID_LENGTH = 48;
export const MAX_TASK_TITLE_LENGTH = 48;
const LEGACY_MAX_TASK_TITLE_LENGTH = 120;

export type TaskStatus = "pending" | "in_progress" | "completed";
export type SessionPhase = "running" | "settled";
export type TaskUIState = "hidden" | "running" | "paused" | "completed";

export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
}

export interface TaskSnapshot {
	revision: number;
	tasks: Task[];
}

export interface RemovedTaskChange {
	id: string;
	title: string;
}

export interface RenamedTaskChange {
	id: string;
	from: string;
	to: string;
}

export interface TaskChanges {
	added: string[];
	removed: Array<string | RemovedTaskChange>;
	started: string[];
	completed: string[];
	reopened: string[];
	renamed: Array<string | RenamedTaskChange>;
	reordered: boolean;
}

export interface TaskToolDetails extends TaskSnapshot {
	schemaVersion?: 1;
	changes: TaskChanges;
	unchanged: boolean;
}

export interface TaskReadDetails extends TaskSnapshot {
	schemaVersion: 1;
}

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TASK_TITLE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const TASK_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed"]);

export function cloneTasks(tasks: readonly Task[]): Task[] {
	return tasks.map((task) => ({ ...task }));
}

export function emptyChanges(): TaskChanges {
	return {
		added: [],
		removed: [],
		started: [],
		completed: [],
		reopened: [],
		renamed: [],
		reordered: false,
	};
}

export function validateTaskList(
	tasks: readonly Task[],
	maxTitleLength = MAX_TASK_TITLE_LENGTH,
): void {
	if (tasks.length > MAX_TASKS) {
		throw new Error(`Task list cannot contain more than ${MAX_TASKS} tasks.`);
	}

	const ids = new Set<string>();

	for (const task of tasks) {
		if (!task || typeof task !== "object") {
			throw new Error("Every task must be an object.");
		}
		if (typeof task.id !== "string" || task.id.length === 0 || task.id.length > MAX_TASK_ID_LENGTH) {
			throw new Error(`Task IDs must be 1-${MAX_TASK_ID_LENGTH} characters.`);
		}
		if (!TASK_ID_PATTERN.test(task.id)) {
			throw new Error(`Invalid task ID "${task.id}". Use letters, numbers, hyphens, or underscores.`);
		}
		if (ids.has(task.id)) {
			throw new Error(`Duplicate task ID: ${task.id}`);
		}
		ids.add(task.id);

		if (
			typeof task.title !== "string" ||
			task.title.trim().length === 0 ||
			task.title.length > maxTitleLength
		) {
			throw new Error(`Task titles must be 1-${maxTitleLength} non-blank characters.`);
		}
		if (TASK_TITLE_CONTROL_PATTERN.test(task.title)) {
			throw new Error(`Task title for "${task.id}" cannot contain control characters.`);
		}
		if (!TASK_STATUSES.has(task.status)) {
			throw new Error(`Invalid status for task "${task.id}": ${String(task.status)}`);
		}
	}

	if (tasks.length === 0) return;

	const unfinishedCount = tasks.filter((task) => task.status !== "completed").length;
	const inProgressCount = tasks.filter((task) => task.status === "in_progress").length;

	if (unfinishedCount > 0 && inProgressCount !== 1) {
		throw new Error("An unfinished task list must contain exactly one in_progress task.");
	}
	if (unfinishedCount === 0 && inProgressCount !== 0) {
		throw new Error("A completed task list cannot contain an in_progress task.");
	}
}

export function tasksEqual(a: readonly Task[], b: readonly Task[]): boolean {
	if (a.length !== b.length) return false;

	return a.every((task, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			task.id === other.id &&
			task.title === other.title &&
			task.status === other.status
		);
	});
}

export function diffTasks(previous: readonly Task[], next: readonly Task[]): TaskChanges {
	const changes = emptyChanges();
	const before = new Map(previous.map((task) => [task.id, task]));
	const after = new Map(next.map((task) => [task.id, task]));

	for (const task of next) {
		const old = before.get(task.id);
		if (!old) {
			changes.added.push(task.id);
		}
		if ((!old || old.status !== "in_progress") && task.status === "in_progress") {
			changes.started.push(task.id);
		}
		if ((!old || old.status !== "completed") && task.status === "completed") {
			changes.completed.push(task.id);
		}
		if (old?.status === "completed" && task.status !== "completed") {
			changes.reopened.push(task.id);
		}
		if (old && old.title !== task.title) {
			changes.renamed.push({ id: task.id, from: old.title, to: task.title });
		}
	}

	for (const task of previous) {
		if (!after.has(task.id)) {
			changes.removed.push({ id: task.id, title: task.title });
		}
	}

	const retainedBefore = previous.filter((task) => after.has(task.id)).map((task) => task.id);
	const retainedAfter = next.filter((task) => before.has(task.id)).map((task) => task.id);
	changes.reordered =
		retainedBefore.length === retainedAfter.length &&
		retainedBefore.some((id, index) => retainedAfter[index] !== id);

	return changes;
}

export function deriveTaskUIState(
	snapshot: TaskSnapshot | undefined,
	sessionPhase: SessionPhase,
	dismissedRevision?: number,
): TaskUIState {
	if (!snapshot || snapshot.tasks.length === 0) return "hidden";

	const allCompleted = snapshot.tasks.every((task) => task.status === "completed");
	if (allCompleted) {
		return dismissedRevision === snapshot.revision ? "hidden" : "completed";
	}

	const hasInProgress = snapshot.tasks.some((task) => task.status === "in_progress");
	if (hasInProgress && sessionPhase === "settled") return "paused";

	return "running";
}

function isTaskSnapshot(value: unknown, minimumRevision: number): value is TaskSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<TaskSnapshot>;
	if (
		!Number.isInteger(snapshot.revision) ||
		(snapshot.revision ?? -1) < minimumRevision ||
		!Array.isArray(snapshot.tasks)
	) {
		return false;
	}

	try {
		validateTaskList(snapshot.tasks as Task[], LEGACY_MAX_TASK_TITLE_LENGTH);
		return true;
	} catch {
		return false;
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRemovedTaskChange(value: unknown): value is string | RemovedTaskChange {
	if (typeof value === "string") return true;
	if (!value || typeof value !== "object") return false;
	const change = value as Partial<RemovedTaskChange>;
	return typeof change.id === "string" && typeof change.title === "string";
}

function isRenamedTaskChange(value: unknown): value is string | RenamedTaskChange {
	if (typeof value === "string") return true;
	if (!value || typeof value !== "object") return false;
	const change = value as Partial<RenamedTaskChange>;
	return (
		typeof change.id === "string" &&
		typeof change.from === "string" &&
		typeof change.to === "string"
	);
}

function isTaskChanges(value: unknown): value is TaskChanges {
	if (!value || typeof value !== "object") return false;
	const changes = value as Partial<TaskChanges>;
	return (
		isStringArray(changes.added) &&
		Array.isArray(changes.removed) &&
		changes.removed.every(isRemovedTaskChange) &&
		isStringArray(changes.started) &&
		isStringArray(changes.completed) &&
		isStringArray(changes.reopened) &&
		Array.isArray(changes.renamed) &&
		changes.renamed.every(isRenamedTaskChange) &&
		typeof changes.reordered === "boolean"
	);
}

export function isTaskSnapshotDetails(value: unknown): value is TaskSnapshot {
	return isTaskSnapshot(value, 1);
}

export function isTaskReadDetails(value: unknown): value is TaskReadDetails {
	if (!isTaskSnapshot(value, 0)) return false;
	return (value as Partial<TaskReadDetails>).schemaVersion === 1;
}

export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	if (!isTaskSnapshotDetails(value)) return false;
	const details = value as Partial<TaskToolDetails>;
	return (
		(details.schemaVersion === undefined || details.schemaVersion === 1) &&
		typeof details.unchanged === "boolean" &&
		isTaskChanges(details.changes)
	);
}
