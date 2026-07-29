import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = fs
	.readdirSync(path.join(root, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

for (const directory of packageDirectories) {
	const packageRoot = path.join(root, "packages", directory);
	const output = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: packageRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const [result] = JSON.parse(output);
	if (!result || result.error) {
		throw new Error(`npm pack failed for ${directory}`);
	}

	const files = new Set(result.files.map((file) => file.path));
	for (const required of ["package.json", "README.md", "LICENSE"]) {
		if (!files.has(required)) {
			throw new Error(`${result.name} tarball is missing ${required}`);
		}
	}
	for (const forbidden of ["tests/", "node_modules/"]) {
		if ([...files].some((file) => file.startsWith(forbidden))) {
			throw new Error(`${result.name} tarball includes ${forbidden}`);
		}
	}

	console.log(
		`${result.name}@${result.version} · ${result.entryCount} files · ${result.size} bytes`,
	);
}
