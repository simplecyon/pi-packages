import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const expectedPackages = new Map([
	["pi-context-compact", "@cyon/pi-context-compact"],
	["pi-context-inspector", "@cyon/pi-context-inspector"],
	["pi-memory", "@cyon/pi-memory"],
	["pi-minimal-tui", "@cyon/pi-minimal-tui"],
	["pi-session-tasks", "@cyon/pi-session-tasks"],
	["pi-skill-telemetry", "@cyon/pi-skill-telemetry"],
]);

test("aggregate manifest points to existing package resources", () => {
	const resources = [
		...(manifest.pi?.extensions ?? []),
		...(manifest.pi?.themes ?? []),
	];
	assert.equal(resources.length, 7);
	for (const resource of resources) {
		assert.equal(
			fs.existsSync(path.resolve(root, resource)),
			true,
			`missing aggregate resource: ${resource}`,
		);
	}
});

test("workspace package names are unique", () => {
	const packageDirs = fs.readdirSync(path.join(root, "packages"));
	const names = packageDirs.map((dir) => {
		const file = path.join(root, "packages", dir, "package.json");
		return JSON.parse(fs.readFileSync(file, "utf8")).name;
	});
	assert.equal(new Set(names).size, names.length);
});

test("every workspace is independently publishable under @cyon", () => {
	for (const [directory, expectedName] of expectedPackages) {
		const packageRoot = path.join(root, "packages", directory);
		const packageManifest = JSON.parse(
			fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		);

		assert.equal(packageManifest.name, expectedName);
		assert.notEqual(packageManifest.private, true);
		assert.equal(packageManifest.publishConfig?.access, "public");
		assert.equal(
			packageManifest.publishConfig?.registry,
			"https://registry.npmjs.org/",
		);
		assert.equal(packageManifest.repository?.directory, `packages/${directory}`);
		assert.equal(packageManifest.keywords?.includes("pi-package"), true);
		assert.equal(packageManifest.files?.includes("README.md"), true);
		assert.equal(packageManifest.files?.includes("LICENSE"), true);
		assert.equal(fs.existsSync(path.join(packageRoot, "README.md")), true);
		assert.equal(fs.existsSync(path.join(packageRoot, "LICENSE")), true);

		for (const resource of [
			...(packageManifest.pi?.extensions ?? []),
			...(packageManifest.pi?.themes ?? []),
		]) {
			assert.equal(
				fs.existsSync(path.resolve(packageRoot, resource)),
				true,
				`${expectedName} has a missing resource: ${resource}`,
			);
		}
	}
});
