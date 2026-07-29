import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	extractBashPaths,
	findNearestScopeMemory,
	findProjectRoot,
	loadBaseSnapshot,
	looksMutatingBash,
	truncateMemory,
} from "../src/memory.ts";

test("discovers project root and nearest scoped memory", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-discovery-"));
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(root, "MEMORY.md"), "root");
		fs.mkdirSync(path.join(root, "A", "Nested"), { recursive: true });
		fs.writeFileSync(path.join(root, "A", "MEMORY.md"), "scope A");
		const target = path.join(root, "A", "Nested", "file.ts");

		assert.equal(findProjectRoot(path.dirname(target)), root);
		const memory = findNearestScopeMemory(target, root);
		assert.equal(memory?.scopeDir, path.join(root, "A"));
		assert.equal(memory?.content, "scope A");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("base snapshot includes global, project, and cwd scope once", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-base-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-agent-"));
	try {
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(root, "MEMORY.md"), "project");
		fs.writeFileSync(path.join(agent, "MEMORY.md"), "global");
		fs.mkdirSync(path.join(root, "A"));
		fs.writeFileSync(path.join(root, "A", "MEMORY.md"), "scope");

		const snapshot = loadBaseSnapshot(path.join(root, "A"), agent);
		assert.deepEqual(
			snapshot.files.map((file) => file.content),
			["global", "project", "scope"],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("memory truncation preserves head and tail within budget", () => {
	const bounded = truncateMemory(`${"a".repeat(200)}TAIL`, 100);
	assert.equal(bounded.truncated, true);
	assert.ok(bounded.content.length <= 100);
	assert.match(bounded.content, /^a+/);
	assert.match(bounded.content, /TAIL$/);
});

test("detects mutating bash and extracts useful paths", () => {
	assert.equal(looksMutatingBash("sed -i '' Work/WENGE/file.md"), true);
	assert.equal(looksMutatingBash("rg memory Work/WENGE"), false);
	assert.deepEqual(
		extractBashPaths("sed -i '' 'Work/WENGE/file.md'", "/repo"),
		["/repo/Work/WENGE/file.md"],
	);
	assert.deepEqual(
		extractBashPaths("touch /repo/Work/WENGE/file.md", "/elsewhere"),
		["/repo/Work/WENGE/file.md"],
	);
});
