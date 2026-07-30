import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	discoverDiscreteMemories,
	searchDiscreteMemories,
	selectRecall,
	shouldAutoRecall,
	tokenizeRecallText,
} from "../src/recall.ts";

function createProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-recall-"));
	fs.mkdirSync(path.join(root, ".pi"));
	fs.writeFileSync(path.join(root, ".pi", "settings.json"), "{}");
	fs.mkdirSync(path.join(root, ".memory"));
	fs.writeFileSync(
		path.join(root, "MEMORY.md"),
		[
			"# Project Memory",
			"",
			"- Automation and sync: see `.memory/automation-git-sync.md`",
			"  - triggers: scheduled job stuck, git sync, 自动化, 时区",
			"  - use when: a scheduled report fails or repository synchronization breaks",
			"- Package memory: see `.memory/pi-memory-runtime.md`",
			"  - triggers: pi memory, memory injection, 离散记忆, 关键词召回",
			"  - use when: changing runtime recall or memory injection",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(root, ".memory", "automation-git-sync.md"),
		"# Automation Git Sync\n\nFetch errors, dirty worktrees, and RRULE handling.",
	);
	fs.writeFileSync(
		path.join(root, ".memory", "pi-memory-runtime.md"),
		"# Pi Memory Runtime\n\nThe input hook retrieves discrete project memory.",
	);
	return root;
}

test("tokenizes mixed Chinese and technical input while rejecting generic turns", () => {
	const tokens = tokenizeRecallText("pi-package 的 memory 注入与关键词召回");
	assert.ok(tokens.includes("pi"));
	assert.ok(tokens.includes("memory"));
	assert.ok(tokens.includes("召回"));
	assert.equal(shouldAutoRecall("继续"), false);
	assert.equal(shouldAutoRecall("/memory recall sync"), false);
	assert.equal(shouldAutoRecall("检查 memory injection 的召回行为"), true);
});

test("discovers scoped discrete memories and applies indexed trigger weights", () => {
	const root = createProject();
	try {
		const catalog = discoverDiscreteMemories(root, root);
		assert.deepEqual(
			catalog.map((memory) => memory.relativePath),
			[
				".memory/automation-git-sync.md",
				".memory/pi-memory-runtime.md",
			],
		);
		const [hit] = searchDiscreteMemories(
			catalog,
			"把 pi memory 的关键词召回接入 input hook",
		);
		assert.equal(hit?.memory.relativePath, ".memory/pi-memory-runtime.md");
		assert.ok(hit?.reasons.some((reason) => reason.startsWith("triggers")));

		const chinese = searchDiscreteMemories(catalog, "自动化任务时区失败");
		assert.equal(
			chinese[0]?.memory.relativePath,
			".memory/automation-git-sync.md",
		);

		const unrelated = searchDiscreteMemories(
			catalog,
			"database schema caching memory",
		);
		assert.equal(unrelated.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("includes ancestor scope catalogs but ignores oversized files and symlinks", () => {
	const root = createProject();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-outside-"));
	try {
		const scope = path.join(root, "Work", "Project");
		fs.mkdirSync(path.join(scope, ".memory"), { recursive: true });
		fs.writeFileSync(
			path.join(scope, "MEMORY.md"),
			"- Scoped note: see `.memory/scoped.md`\n  - triggers: local scope",
		);
		fs.writeFileSync(path.join(scope, ".memory", "scoped.md"), "# Scoped");
		fs.writeFileSync(
			path.join(scope, ".memory", "large.md"),
			"x".repeat(2_000),
		);
		fs.writeFileSync(path.join(outside, "secret.md"), "# Outside");
		fs.symlinkSync(
			path.join(outside, "secret.md"),
			path.join(scope, ".memory", "linked.md"),
		);

		const catalog = discoverDiscreteMemories(scope, root, {
			maxFileBytes: 1_000,
		});
		assert.ok(
			catalog.some(
				(memory) => memory.relativePath === ".memory/pi-memory-runtime.md",
			),
		);
		assert.ok(
			catalog.some(
				(memory) =>
					memory.relativePath === "Work/Project/.memory/scoped.md",
			),
		);
		assert.equal(
			catalog.some((memory) => memory.relativePath.endsWith("large.md")),
			false,
		);
		assert.equal(
			catalog.some((memory) => memory.relativePath.endsWith("linked.md")),
			false,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("selects bounded top hits and signs query plus file content", () => {
	const root = createProject();
	try {
		fs.writeFileSync(
			path.join(root, ".memory", "pi-memory-runtime.md"),
			`# Pi Memory Runtime\n\n${"memory injection ".repeat(1_000)}`,
		);
		const catalog = discoverDiscreteMemories(root, root);
		const hits = searchDiscreteMemories(catalog, "pi memory injection", {
			minScore: 1,
		});
		const selection = selectRecall("pi memory injection", hits, {
			limit: 2,
			maxChars: 1_500,
		});
		assert.ok(selection);
		assert.ok(selection.content.length <= 1_500);
		assert.equal(selection.truncated, true);
		assert.match(selection.content, /<memory_recall/);
		assert.match(selection.content, /\.memory\/pi-memory-runtime\.md/);

		const firstSignature = selection.signature;
		fs.appendFileSync(
			path.join(root, ".memory", "pi-memory-runtime.md"),
			"\nchanged",
		);
		const changed = selectRecall(
			"pi memory injection",
			searchDiscreteMemories(
				discoverDiscreteMemories(root, root),
				"pi memory injection",
				{ minScore: 1 },
			),
			{ maxChars: 1_500 },
		);
		assert.ok(changed);
		assert.notEqual(changed.signature, firstSignature);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
