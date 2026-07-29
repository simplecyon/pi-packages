import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

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
