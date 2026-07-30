import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveTaskUIState,
	diffTasks,
	isTaskReadDetails,
	isTaskSnapshotDetails,
	isTaskToolDetails,
	validateTaskList,
	type Task,
} from "../src/model.ts";

const activeTasks: Task[] = [
	{ id: "inspect", title: "Inspect implementation", status: "in_progress" },
	{ id: "verify", title: "Verify behavior", status: "pending" },
];

test("validateTaskList enforces task-state invariants", () => {
	assert.doesNotThrow(() => validateTaskList(activeTasks));
	assert.throws(
		() =>
			validateTaskList([
				{ id: "a", title: "A", status: "pending" },
				{ id: "b", title: "B", status: "pending" },
			]),
		/exactly one in_progress/,
	);
});

test("validateTaskList rejects layout and terminal control characters", () => {
	for (const title of [
		`line one${String.fromCharCode(10)}line two`,
		`clipboard${String.fromCharCode(27)}]52;c;SGVsbG8=${String.fromCharCode(7)}`,
	]) {
		assert.throws(
			() => validateTaskList([{ id: "unsafe", title, status: "in_progress" }]),
			/control characters/,
		);
	}
});

test("validateTaskList keeps task titles compact", () => {
	assert.doesNotThrow(() =>
		validateTaskList([
			{ id: "concise", title: "Tighten title rules", status: "in_progress" },
		]),
	);
	assert.doesNotThrow(() =>
		validateTaskList([
			{
				id: "technical",
				title: "修复 scroll-fade/scroll-bottom-btn 与 conversation 层级",
				status: "in_progress",
			},
		]),
	);
	assert.throws(
		() =>
			validateTaskList([
				{
					id: "verbose",
					title: "x".repeat(121),
					status: "in_progress",
				},
			]),
		/1-120 non-blank characters/,
	);
});

test("diffTasks preserves rename and removal context", () => {
	const previous: Task[] = [
		{ id: "inspect", title: "Inspect implementation", status: "in_progress" },
		{ id: "obsolete", title: "Remove obsolete path", status: "pending" },
	];
	const next: Task[] = [
		{ id: "inspect", title: "Inspect extension implementation", status: "completed" },
		{ id: "verify", title: "Verify behavior", status: "in_progress" },
	];

	assert.deepEqual(diffTasks(previous, next), {
		added: ["verify"],
		removed: [{ id: "obsolete", title: "Remove obsolete path" }],
		started: ["verify"],
		completed: ["inspect"],
		reopened: [],
		renamed: [
			{
				id: "inspect",
				from: "Inspect implementation",
				to: "Inspect extension implementation",
			},
		],
		reordered: false,
	});
});

test("details guards separate snapshots, reads, and complete update details", () => {
	const snapshot = { revision: 1, tasks: activeTasks };
	const read = { schemaVersion: 1 as const, revision: 0, tasks: [] };
	const complete = {
		schemaVersion: 1 as const,
		...snapshot,
		changes: {
			added: [],
			removed: [],
			started: [],
			completed: [],
			reopened: [],
			renamed: [],
			reordered: false,
		},
		unchanged: true,
	};

	assert.equal(isTaskSnapshotDetails(snapshot), true);
	assert.equal(isTaskReadDetails(read), true);
	assert.equal(isTaskToolDetails(snapshot), false);
	assert.equal(isTaskToolDetails(complete), true);
});

test("deriveTaskUIState covers running, paused, completed, and dismissed states", () => {
	const active = { revision: 1, tasks: activeTasks };
	const completed = {
		revision: 2,
		tasks: activeTasks.map((task) => ({ ...task, status: "completed" as const })),
	};

	assert.equal(deriveTaskUIState(undefined, "settled"), "hidden");
	assert.equal(deriveTaskUIState(active, "running"), "running");
	assert.equal(deriveTaskUIState(active, "settled"), "paused");
	assert.equal(deriveTaskUIState(completed, "settled"), "completed");
	assert.equal(deriveTaskUIState(completed, "settled", 2), "hidden");
});
