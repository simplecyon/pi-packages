import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchRecords } from "../src/search.ts";
import {
	appendRecords,
	createRecord,
	projectStorePath,
	readStore,
	replaceSource,
} from "../src/storage.ts";

test("serializes concurrent writes, deduplicates records, and persists privately", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-engine-store-"));
	const previous = process.env.PI_CONTEXT_ENGINE_DIR;
	process.env.PI_CONTEXT_ENGINE_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ENGINE_DIR;
		else process.env.PI_CONTEXT_ENGINE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-engine-project-"));
	t.after(() => rm(projectDir, { recursive: true, force: true }));

	const records = Array.from({ length: 40 }, (_, index) =>
		createRecord({
			kind: "session",
			source: "session:test",
			title: `event ${index}`,
			content: `并发记录 ${index}`,
			sessionRef: "test",
		})
	);
	await Promise.all(records.map((record) => appendRecords(projectDir, [record])));
	assert.equal((await readStore(projectDir)).records.length, 40);
	assert.equal(await appendRecords(projectDir, records), 0);
	assert.equal((await stat(projectStorePath(projectDir))).mode & 0o777, 0o600);
});

test("replaces stable sources and ranks multilingual exact matches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-engine-search-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-engine-project-"));
	const previous = process.env.PI_CONTEXT_ENGINE_DIR;
	process.env.PI_CONTEXT_ENGINE_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ENGINE_DIR;
		else process.env.PI_CONTEXT_ENGINE_DIR = previous;
		await rm(root, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	await replaceSource(projectDir, "manual", [
		createRecord({
			kind: "document",
			source: "manual",
			title: "旧内容",
			content: "这条记录应被替换",
		}),
	]);
	await replaceSource(projectDir, "manual", [
		createRecord({
			kind: "document",
			source: "manual",
			title: "Token ROI 决策",
			content: "优先提升 token ROI，并迁移 END-MANUAL-ROI 标记。",
		}),
	]);
	const store = await readStore(projectDir);
	assert.equal(store.records.length, 1);
	const [hit] = searchRecords(store.records, "提升 token ROI", { limit: 1 });
	assert.ok(hit);
	assert.equal(hit.source, "manual");
	assert.match(hit.snippet, /token ROI/i);
	assert.equal(searchRecords(store.records, "不存在的词").length, 0);
});
