import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Pi loads the aggregate package without duplicate or invalid resources", async (t) => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-packages-loader-"),
	);
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

	const settingsManager = SettingsManager.inMemory(
		{ packages: [root] },
		{ projectTrusted: true },
	);
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});

	await loader.reload();

	const extensionResult = loader.getExtensions();
	const themeResult = loader.getThemes();
	assert.deepEqual(extensionResult.errors, []);
	assert.deepEqual(themeResult.diagnostics, []);
	assert.equal(extensionResult.extensions.length, 6);
	assert.equal(
		new Set(extensionResult.extensions.map((extension) => extension.path)).size,
		6,
	);
	assert.deepEqual(
		themeResult.themes.map((theme) => theme.name),
		["cyon-minimal-dark"],
	);
});
