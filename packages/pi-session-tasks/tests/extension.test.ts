import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { TOKEN_ROI_MILESTONE_EVENT } from "@simplecyon/pi-context-core";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const loaderUrl = pathToFileURL(
	join(
		globalRoot,
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"extensions",
		"loader.js",
	),
).href;
const eventBusUrl = pathToFileURL(
	join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "core", "event-bus.js"),
).href;
const { loadExtensions } = await import(loaderUrl);
const { createEventBus } = await import(eventBusUrl);
const eventBuses = new WeakMap<object, ReturnType<typeof createEventBus>>();

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
	strikethrough: (value: string) => value,
};
const context = {
	hasUI: false,
	mode: "print",
	ui: {
		theme,
		setWidget() {},
		setStatus() {},
		notify() {},
	},
	sessionManager: {
		getBranch: () => [],
	},
};

async function loadSessionTasks() {
	const eventBus = createEventBus();
	const loaded = await loadExtensions([extensionPath], process.cwd(), eventBus);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	eventBuses.set(loaded.extensions[0], eventBus);
	return loaded.extensions[0];
}

function toolDefinition(extension: Awaited<ReturnType<typeof loadSessionTasks>>, name: string) {
	const registered = extension.tools.get(name);
	assert.ok(registered, `${name} should be registered`);
	return registered.definition;
}

test("extension registers read/write tools, command, and lifecycle handlers", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");

	assert.deepEqual([...extension.tools.keys()], ["get_tasks", "update_tasks"]);
	assert.deepEqual(update.parameters.required, ["expected_revision", "tasks"]);
	assert.equal(update.parameters.properties.tasks.items.properties.title.maxLength, 120);
	assert.match(
		update.parameters.properties.tasks.items.properties.title.description,
		/Short verb-object label/,
	);
	assert.ok(
		update.promptGuidelines.some((guideline: string) =>
			guideline.includes("compact verb-object label"),
		),
	);
	assert.ok(
		update.promptGuidelines.some((guideline: string) =>
			guideline.includes("Keep the title unchanged"),
		),
	);
	assert.deepEqual([...extension.commands.keys()], ["tasks"]);
	assert.deepEqual([...extension.handlers.keys()], [
		"session_start",
		"session_tree",
		"agent_start",
		"agent_settled",
		"input",
		"session_shutdown",
	]);
});

test("read/update workflow exposes revisions and rejects stale replacements", async () => {
	const extension = await loadSessionTasks();
	const read = toolDefinition(extension, "get_tasks");
	const update = toolDefinition(extension, "update_tasks");

	const initial = await read.execute("read-0", {}, undefined, undefined, context);
	assert.equal(initial.details.revision, 0);
	assert.deepEqual(initial.details.tasks, []);

	const tasks = [
		{ id: "implement", title: "Implement safe task state", status: "in_progress" },
		{ id: "verify", title: "Verify the extension", status: "pending" },
	];
	const created = await update.execute(
		"update-1",
		{ expected_revision: 0, tasks },
		undefined,
		undefined,
		context,
	);
	assert.equal(created.details.revision, 1);
	assert.match(created.content[0].text, /Revision: 1/);

	const stale = await update.execute(
		"update-stale",
		{
			expected_revision: 0,
			tasks: [
				{ id: "overwrite", title: "Overwrite newer state", status: "in_progress" },
			],
		},
		undefined,
		undefined,
		context,
	);
	assert.equal(stale.details, undefined);
	assert.match(stale.content[0].text, /expected revision 0.*current revision is 1/);

	const current = await read.execute("read-1", {}, undefined, undefined, context);
	assert.equal(current.details.revision, 1);
	assert.deepEqual(current.details.tasks, tasks);
});

test("emits aggregate milestones when tasks transition to completed", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const milestones: unknown[] = [];
	eventBuses.get(extension)!.on(TOKEN_ROI_MILESTONE_EVENT, (data: unknown) => {
		milestones.push(data);
	});

	await update.execute(
		"update-milestone-1",
		{
			expected_revision: 0,
			tasks: [
				{ id: "implement", title: "Implement the change", status: "in_progress" },
				{ id: "verify", title: "Verify the change", status: "pending" },
			],
		},
		undefined,
		undefined,
		context,
	);
	await update.execute(
		"update-milestone-2",
		{
			expected_revision: 1,
			tasks: [
				{ id: "implement", title: "Implement the change", status: "completed" },
				{ id: "verify", title: "Verify the change", status: "in_progress" },
			],
		},
		undefined,
		undefined,
		context,
	);

	assert.deepEqual(milestones, [{ kind: "session_task_completed", count: 1 }]);
});

test("task tools use compact collapsed rows and reveal results only when expanded", async () => {
	const extension = await loadSessionTasks();
	const read = toolDefinition(extension, "get_tasks");
	const update = toolDefinition(extension, "update_tasks");
	const tasks = [{ id: "render", title: "Verify compact rendering", status: "in_progress" }];
	const result = await update.execute(
		"update-render",
		{ expected_revision: 0, tasks },
		undefined,
		undefined,
		context,
	);

	assert.equal(read.renderShell, "self");
	assert.equal(update.renderShell, "self");
	assert.deepEqual(
		update.renderCall({ expected_revision: 0, tasks }, theme, {}).render(80).map((line: string) => line.trimEnd()),
		["·update tasks 1 task"],
	);
	assert.deepEqual(
		update.renderResult(result, { expanded: false }, theme, {}).render(80),
		[],
	);
	assert.match(
		update.renderResult(result, { expanded: true }, theme, {}).render(80).join("\n"),
		/Added|Started/,
	);

	const retitled = await update.execute(
		"update-retitle",
		{
			expected_revision: 1,
			tasks: [{ id: "render", title: "Verify concise rendering", status: "in_progress" }],
		},
		undefined,
		undefined,
		context,
	);
	assert.match(
		update.renderResult(retitled, { expanded: true }, theme, {}).render(80).join("\n"),
		/Title changed  Verify compact rendering → Verify concise rendering/,
	);
});

test("task validation failures stay concise until tool output is expanded", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const validationError = {
		content: [
			{
				type: "text",
				text:
					'Validation failed for tool "update_tasks":\n' +
					"  - tasks.1.title: must not have more than 120 characters\n\n" +
					'Received arguments:\n{"tasks":[{"title":"very long title"}]}',
			},
		],
		details: undefined,
	};

	assert.deepEqual(
		update.renderResult(validationError, { expanded: false }, theme, {}).render(80).map((line: string) => line.trimEnd()),
		["Task update rejected · tasks.1.title: must not have more than 120 characters"],
	);
	assert.match(
		update.renderResult(validationError, { expanded: true }, theme, {}).render(80).join("\n"),
		/Received arguments/,
	);
});

test("task UI never publishes progress to the bottom status line", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const statusValues: unknown[] = [];
	const widgetValues: unknown[] = [];
	const tuiContext = {
		...context,
		hasUI: true,
		mode: "tui",
		ui: {
			...context.ui,
			setWidget(_key: string, value: unknown) {
				widgetValues.push(value);
			},
			setStatus(_key: string, value: unknown) {
				statusValues.push(value);
			},
		},
	};

	await update.execute(
		"update-footer",
		{
			expected_revision: 0,
			tasks: [{ id: "footer", title: "Remove footer status", status: "in_progress" }],
		},
		undefined,
		undefined,
		tuiContext,
	);

	assert.ok(widgetValues.some((value) => typeof value === "function"));
	assert.ok(statusValues.length > 0);
	assert.ok(statusValues.every((value) => value === undefined));
});

test("exclusive UI events temporarily hide and restore the task widget", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const widgetValues: unknown[] = [];
	const tuiContext = {
		...context,
		hasUI: true,
		mode: "tui",
		ui: {
			...context.ui,
			setWidget(_key: string, value: unknown) {
				widgetValues.push(value);
			},
		},
	};

	await update.execute(
		"update-exclusive",
		{
			expected_revision: 0,
			tasks: [{ id: "ask", title: "Answer blocking question", status: "in_progress" }],
		},
		undefined,
		undefined,
		tuiContext,
	);
	assert.equal(typeof widgetValues.at(-1), "function");

	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "acquire",
		token: "ask-1",
		source: "AskUserQuestion",
	});
	assert.equal(widgetValues.at(-1), undefined);

	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "release",
		token: "ask-1",
		source: "AskUserQuestion",
	});
	assert.equal(typeof widgetValues.at(-1), "function");
});

test("nested exclusive UI tokens restore only after the final release", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const widgetValues: unknown[] = [];
	const tuiContext = {
		...context,
		hasUI: true,
		mode: "tui",
		ui: {
			...context.ui,
			setWidget(_key: string, value: unknown) {
				widgetValues.push(value);
			},
		},
	};
	await update.execute(
		"update-nested",
		{
			expected_revision: 0,
			tasks: [{ id: "nested", title: "Handle nested dialogs", status: "in_progress" }],
		},
		undefined,
		undefined,
		tuiContext,
	);
	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "acquire",
		token: "a",
		source: "test",
	});
	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "acquire",
		token: "b",
		source: "test",
	});
	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "release",
		token: "a",
		source: "test",
	});
	assert.equal(widgetValues.at(-1), undefined);
	eventBuses.get(extension)!.emit("simplecyon:ui-exclusive", {
		action: "release",
		token: "b",
		source: "test",
	});
	assert.equal(typeof widgetValues.at(-1), "function");
});

test("parallel replacements from the same revision cannot overwrite each other", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");

	const replacements = [
		[{ id: "first", title: "Apply the first update", status: "in_progress" }],
		[{ id: "second", title: "Apply the second update", status: "in_progress" }],
	];
	const results = await Promise.all(
		replacements.map((tasks, index) =>
			update.execute(
				`parallel-${index}`,
				{ expected_revision: 0, tasks },
				undefined,
				undefined,
				context,
			),
		),
	);

	assert.equal(results.filter((result) => result.details?.revision === 1).length, 1);
	assert.equal(results.filter((result) => /update rejected/.test(result.content[0].text)).length, 1);
});

test("session reconstruction accepts legacy snapshots without trusting malformed render details", async () => {
	const extension = await loadSessionTasks();
	const update = toolDefinition(extension, "update_tasks");
	const read = toolDefinition(extension, "get_tasks");
	const legacyTasks = [
		{
			id: "legacy",
			title: "Restore a legacy snapshot whose title predates the compact title limit",
			status: "in_progress",
		},
	];
	const sessionStart = extension.handlers.get("session_start")?.[0];
	assert.ok(sessionStart);

	await sessionStart(
		{ type: "session_start", reason: "resume" },
		{
			...context,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "update_tasks",
							details: { revision: 4, tasks: legacyTasks },
						},
					},
				],
			},
		},
	);

	const restored = await read.execute("read-restored", {}, undefined, undefined, context);
	assert.equal(restored.details.revision, 4);
	assert.deepEqual(restored.details.tasks, legacyTasks);

	assert.doesNotThrow(() =>
		update.renderResult(
			{
				content: [{ type: "text", text: "Fallback text" }],
				details: { revision: 4, tasks: legacyTasks },
			},
			{ expanded: false },
			theme,
		),
	);
});
