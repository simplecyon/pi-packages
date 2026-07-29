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
	for (const forbidden of ["tests/"]) {
		if ([...files].some((file) => file.startsWith(forbidden))) {
			throw new Error(`${result.name} tarball includes ${forbidden}`);
		}
	}
	const bundledDependencies = new Set(result.bundled ?? []);
	const nodeModuleFiles = [...files].filter((file) => file.startsWith("node_modules/"));
	if (bundledDependencies.size === 0 && nodeModuleFiles.length > 0) {
		throw new Error(`${result.name} tarball includes undeclared node_modules content`);
	}
	for (const file of nodeModuleFiles) {
		const allowed = [...bundledDependencies].some((dependency) =>
			file.startsWith(`node_modules/${dependency}/`)
		);
		if (!allowed) {
			throw new Error(`${result.name} tarball includes unexpected bundled file: ${file}`);
		}
	}

	console.log(
		`${result.name}@${result.version} · ${result.entryCount} files · ${result.size} bytes`,
	);
}
