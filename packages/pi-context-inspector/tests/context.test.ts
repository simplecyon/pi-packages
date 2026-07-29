import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const globalRoot = execFileSync("npm", ["root", "-g"], {
	encoding: "utf8",
}).trim();
const loaderUrl = pathToFileURL(
	path.join(
		globalRoot,
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"extensions",
		"loader.js",
	),
).href;
const { loadExtensions } = await import(loaderUrl);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

test("avoids TUI components outside TUI mode and does not double-count base memory", async () => {
	const loaded = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	loaded.runtime.getActiveTools = () => [];
	loaded.runtime.getAllTools = () => [];
	const handler = extension.commands.get("context")?.handler;
	assert.ok(handler);
	let notification = "";

	const memoryContent = "MEMORY1";
	const fullSystemPrompt = `BASEBASE${memoryContent}`;
	const entries = [
		{
			type: "custom",
			customType: "memory-base-injection",
			data: {
				signature: "test",
				files: [
					{
						path: "MEMORY.md",
						content: memoryContent,
						scopeDir: process.cwd(),
					},
				],
			},
		},
	];
	await handler("", {
		mode: "print",
		model: { contextWindow: 100 },
		ui: {
			notify(message: string) {
				notification = message;
			},
			custom() {
				throw new Error("TUI custom component should not be used in print mode");
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => undefined,
		},
		getSystemPromptOptions: () => ({ skills: [], contextFiles: [] }),
		getSystemPrompt: () => fullSystemPrompt,
		getContextUsage: () => undefined,
	});

	assert.match(notification, /^Context: 4 \/ 100/);
});
