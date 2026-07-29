import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const loaderUrl = pathToFileURL(
	join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js"),
).href;
const eventBusUrl = pathToFileURL(
	join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "core", "event-bus.js"),
).href;
const { loadExtensions } = await import(loaderUrl);
const { createEventBus } = await import(eventBusUrl);
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const eventBuses = new WeakMap<object, ReturnType<typeof createEventBus>>();

async function loadAsk() {
	const eventBus = createEventBus();
	const loaded = await loadExtensions([extensionPath], process.cwd(), eventBus);
	assert.deepEqual(loaded.errors, []);
	eventBuses.set(loaded.extensions[0], eventBus);
	return loaded.extensions[0];
}

const params = {
	questions: [
		{
			header: "Scope",
			question: "Which scope?",
			options: [
				{ label: "Local", description: "Current project." },
				{ label: "Global", description: "Every project." },
			],
		},
	],
};

test("registers a sequential AskUserQuestion tool", async () => {
	const extension = await loadAsk();
	const tool = extension.tools.get("AskUserQuestion")?.definition;
	assert.ok(tool);
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.parameters.properties.questions.minItems, 1);
	assert.equal(tool.parameters.properties.questions.maxItems, 4);
	assert.match(tool.description, /Do not use for dangerous-action confirmation/);
});

test("returns unavailable in print mode", async () => {
	const extension = await loadAsk();
	const tool = extension.tools.get("AskUserQuestion")!.definition;
	const result = await tool.execute(
		"ask-print",
		params,
		undefined,
		undefined,
		{ hasUI: false, mode: "print" },
	);
	assert.equal(result.details.status, "unavailable");
	assert.match(result.content[0].text, /print mode/);
});

test("acquires and releases exclusive UI around the TUI dialog", async () => {
	const extension = await loadAsk();
	const tool = extension.tools.get("AskUserQuestion")!.definition;
	const events: unknown[] = [];
	eventBuses.get(extension)!.on("simplecyon:ui-exclusive", (event: unknown) => events.push(event));
	const working: boolean[] = [];
	const result = await tool.execute(
		"ask-tui",
		params,
		undefined,
		undefined,
		{
			hasUI: true,
			mode: "tui",
			ui: {
				setWorkingVisible(value: boolean) {
					working.push(value);
				},
				custom: async () => ({ cancelled: true, answers: [] }),
			},
		},
	);
	assert.equal(result.details.status, "cancelled");
	assert.equal(result.terminate, true);
	assert.deepEqual(working, [false, true]);
	assert.deepEqual(events, [
		{ action: "acquire", token: "ask-tui", source: "AskUserQuestion" },
		{ action: "release", token: "ask-tui", source: "AskUserQuestion" },
	]);
});
