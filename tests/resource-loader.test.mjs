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
const aggregateManifest = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const workspaces = [
	["pi-ask-user-question", 1, 0, 0],
	["pi-context-artifacts", 1, 0, 0],
	["pi-context-compact", 1, 0, 0],
	["pi-context-engine", 1, 0, 0],
	["pi-context-inspector", 1, 0, 0],
	["pi-memory", 1, 0, 1],
	["pi-minimal-tui", 1, 1, 0],
	["pi-safe-operation", 1, 0, 0],
	["pi-session-tasks", 1, 0, 0],
	["pi-skill-telemetry", 1, 0, 0],
	["pi-token-roi", 1, 0, 0],
	["pi-tool-runtime", 1, 0, 0],
];

async function loadPackage(packageRoot, agentDir) {
	const settingsManager = SettingsManager.inMemory(
		{ packages: [packageRoot] },
		{ projectTrusted: true },
	);
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noSkills: false,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader;
}

function skillsOwnedBy(packageRoot, skills) {
	const owner = path.resolve(packageRoot);
	return skills.filter((skill) => {
		const relative = path.relative(owner, path.resolve(skill.filePath));
		return (
			relative === "" ||
			(!relative.startsWith(`..${path.sep}`) &&
				relative !== ".." &&
				!path.isAbsolute(relative))
		);
	});
}

test("Pi loads the aggregate package without duplicate or invalid resources", async (t) => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-packages-loader-"),
	);
	t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

	const loader = await loadPackage(root, agentDir);

	const extensionResult = loader.getExtensions();
	const skillResult = loader.getSkills();
	const themeResult = loader.getThemes();
	assert.deepEqual(extensionResult.errors, []);
	assert.deepEqual(skillResult.diagnostics, []);
	assert.deepEqual(themeResult.diagnostics, []);
	const expectedExtensionCount = aggregateManifest.pi.extensions.length;
	assert.equal(extensionResult.extensions.length, expectedExtensionCount);
	assert.equal(
		new Set(extensionResult.extensions.map((extension) => extension.path)).size,
		expectedExtensionCount,
	);
	assert.deepEqual(
		themeResult.themes.map((theme) => theme.name),
		["cyon-minimal-dark"],
	);
	assert.deepEqual(
		skillsOwnedBy(root, skillResult.skills).map((skill) => skill.name),
		["memory-maintainer"],
	);
});

test("Pi loads every extension workspace as an independent package", async (t) => {
	for (
		const [directory, expectedExtensions, expectedThemes, expectedSkills] of
		workspaces
	) {
		await t.test(directory, async (t) => {
			const agentDir = fs.mkdtempSync(
				path.join(os.tmpdir(), `pi-package-${directory}-`),
			);
			t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

			const packageRoot = path.join(root, "packages", directory);
			const loader = await loadPackage(packageRoot, agentDir);
			const extensionResult = loader.getExtensions();
			const skillResult = loader.getSkills();
			const themeResult = loader.getThemes();

			assert.deepEqual(extensionResult.errors, []);
			assert.deepEqual(skillResult.diagnostics, []);
			assert.deepEqual(themeResult.diagnostics, []);
			assert.equal(extensionResult.extensions.length, expectedExtensions);
			assert.equal(themeResult.themes.length, expectedThemes);
			assert.equal(
				skillsOwnedBy(packageRoot, skillResult.skills).length,
				expectedSkills,
			);
		});
	}
});
