import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateContextMode } from "../src/migrate.ts";
import {
	appendRecords,
	createRecord,
	readStore,
	replaceLegacyMigration,
} from "../src/storage.ts";

function createSessionDatabase(path: string, projectDir: string): void {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE session_meta (project_dir TEXT);
		CREATE TABLE session_events (
			id INTEGER PRIMARY KEY,
			session_id TEXT,
			type TEXT,
			category TEXT,
			priority INTEGER,
			data TEXT,
			created_at TEXT
		);
	`);
	db.prepare("INSERT INTO session_meta(project_dir) VALUES (?)").run(projectDir);
	db.prepare(`
		INSERT INTO session_events(session_id, type, category, priority, data, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		"legacy-session",
		"decision",
		"decision",
		2,
		"Use token=secret and preserve migration evidence",
		"2026-07-28 10:00:00",
	);
	db.prepare(`
		INSERT INTO session_events(session_id, type, category, priority, data, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		"legacy-session",
		"decision",
		"decision",
		2,
		"Use token=secret and preserve migration evidence",
		"2026-07-28 10:00:01",
	);
	db.close();
}

function createContentDatabase(path: string): void {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT, file_path TEXT);
		CREATE TABLE chunks (
			source_id INTEGER,
			title TEXT,
			content TEXT,
			content_type TEXT,
			timestamp TEXT
		);
		INSERT INTO sources(id, label, file_path) VALUES (1, 'manual', 'manual.md');
		INSERT INTO chunks(source_id, title, content, content_type, timestamp)
		VALUES (1, 'Manual', 'END-MANUAL-ROI secret', 'text/plain', '2026-07-28 10:01:00');
	`);
	db.close();
}

test("copies matching legacy SQLite data once, redacts it, and retains source files", async (t) => {
	const legacyRoot = await mkdtemp(join(tmpdir(), "pi-context-legacy-"));
	const storeRoot = await mkdtemp(join(tmpdir(), "pi-context-migrated-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-project-"));
	const previous = process.env.PI_CONTEXT_ENGINE_DIR;
	process.env.PI_CONTEXT_ENGINE_DIR = storeRoot;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ENGINE_DIR;
		else process.env.PI_CONTEXT_ENGINE_DIR = previous;
		await rm(legacyRoot, { recursive: true, force: true });
		await rm(storeRoot, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});
	await mkdir(join(legacyRoot, "sessions"), { recursive: true });
	await mkdir(join(legacyRoot, "content"), { recursive: true });
	const sessionPath = join(legacyRoot, "sessions", "project.db");
	const contentPath = join(legacyRoot, "content", "project.db");
	createSessionDatabase(sessionPath, projectDir);
	createContentDatabase(contentPath);
	createSessionDatabase(
		join(legacyRoot, "sessions", "other.db"),
		await mkdtemp(join(tmpdir(), "pi-context-other-")),
	);
	await appendRecords(projectDir, [createRecord({
		kind: "session",
		source: "session:native",
		title: "native decision",
		content: "keep native continuity",
		sessionRef: "native",
	})]);
	await replaceLegacyMigration(projectDir, "context-mode-pi-v1", [
		createRecord({
			kind: "legacy-session",
			source: "legacy-session:stale",
			title: "stale",
			content: "collapsed v1 copy",
		}),
	], 1);

	const sanitize = (value: string) => value.replace(/secret/g, "[REDACTED]");
	const first = await migrateContextMode({
		projectDir,
		legacyRoot,
		sanitize,
	});
	assert.equal(first.alreadyMigrated, false);
	assert.equal(first.recordsImported, 3);
	assert.equal(first.sourceFiles, 2);
	assert.equal(first.skippedDatabases, 1);
	const store = await readStore(projectDir);
	assert.equal(store.records.length, 4);
	assert.equal(store.records.filter((record) => record.kind === "session").length, 1);
	assert.doesNotMatch(JSON.stringify(store), /collapsed v1 copy/);
	assert.match(JSON.stringify(store), /END-MANUAL-ROI/);
	assert.doesNotMatch(JSON.stringify(store), /secret/);
	await stat(sessionPath);
	await stat(contentPath);

	const second = await migrateContextMode({
		projectDir,
		legacyRoot,
		sanitize,
	});
	assert.equal(second.alreadyMigrated, true);
	assert.equal((await readStore(projectDir)).records.length, 4);
});
