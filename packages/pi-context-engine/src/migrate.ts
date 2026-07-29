import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chunkText } from "./chunk.ts";
import {
	canonicalProjectDir,
	createRecord,
	readStore,
	replaceLegacyMigration,
} from "./storage.ts";
import type {
	ContextRecord,
	MigrationResult,
} from "./types.ts";

const MIGRATION_NAME = "context-mode-pi-v2";

interface StatementLike {
	all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
	prepare(sql: string): StatementLike;
	close(): void;
}

interface LegacySessionMeta {
	project_dir?: unknown;
}

interface LegacyEvent {
	session_id?: unknown;
	type?: unknown;
	category?: unknown;
	priority?: unknown;
	data?: unknown;
	created_at?: unknown;
}

interface LegacyChunk {
	title?: unknown;
	content?: unknown;
	label?: unknown;
	content_type?: unknown;
	timestamp?: unknown;
	file_path?: unknown;
}

async function openReadOnly(path: string): Promise<DatabaseLike> {
	const sqlite = await import("node:sqlite");
	return new sqlite.DatabaseSync(path, {
		readOnly: true,
	}) as unknown as DatabaseLike;
}

async function databaseFiles(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory))
			.filter((name) => name.endsWith(".db"))
			.sort()
			.map((name) => join(directory, name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function legacyTimestamp(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return new Date().toISOString();
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	return Number.isFinite(Date.parse(normalized))
		? new Date(normalized).toISOString()
		: new Date().toISOString();
}

function matchingProject(meta: LegacySessionMeta[], projectDir: string): boolean {
	const expected = canonicalProjectDir(projectDir);
	return meta.some((row) =>
		typeof row.project_dir === "string" &&
		canonicalProjectDir(row.project_dir) === expected
	);
}

async function readLegacySessionDatabase(
	path: string,
	projectDir: string,
	sanitize: (content: string) => string,
): Promise<{ matches: boolean; records: ContextRecord[] }> {
	const db = await openReadOnly(path);
	try {
		const meta = db.prepare(
			"SELECT DISTINCT project_dir FROM session_meta",
		).all() as LegacySessionMeta[];
		if (!matchingProject(meta, projectDir)) {
			return { matches: false, records: [] };
		}
		const events = db.prepare(`
			SELECT session_id, type, category, priority, data, created_at
			FROM session_events
			ORDER BY id ASC
		`).all() as LegacyEvent[];
		const records: ContextRecord[] = [];
		for (const event of events) {
			if (typeof event.data !== "string" || !event.data.trim()) continue;
			const sessionId =
				typeof event.session_id === "string" ? event.session_id : "unknown";
			const category =
				typeof event.category === "string" ? event.category : "legacy";
			const eventType =
				typeof event.type === "string" ? event.type : "event";
			records.push(createRecord({
				kind: "legacy-session",
				source: `legacy-session:${sessionId}`,
				title: `${category}/${eventType}`,
				content: sanitize(event.data),
				createdAt: legacyTimestamp(event.created_at),
				sessionRef: sessionId,
				category,
				eventType,
			}));
		}
		return { matches: true, records };
	} finally {
		db.close();
	}
}

async function readLegacyContentDatabase(
	path: string,
	sanitize: (content: string) => string,
): Promise<ContextRecord[]> {
	const db = await openReadOnly(path);
	try {
		const chunks = db.prepare(`
			SELECT chunks.title, chunks.content, chunks.content_type,
			       chunks.timestamp, sources.label, sources.file_path
			FROM chunks
			LEFT JOIN sources ON sources.id = chunks.source_id
			ORDER BY chunks.rowid ASC
		`).all() as LegacyChunk[];
		const records: ContextRecord[] = [];
		for (const chunk of chunks) {
			if (typeof chunk.content !== "string" || !chunk.content.trim()) continue;
			const source =
				typeof chunk.label === "string" && chunk.label
					? `legacy-index:${chunk.label}`
					: `legacy-index:${basename(path, ".db")}`;
			records.push(...chunkText({
				content: sanitize(chunk.content),
				source,
				kind: "legacy-document",
				title:
					typeof chunk.title === "string" && chunk.title
						? chunk.title
						: source,
				createdAt: legacyTimestamp(chunk.timestamp),
				...(typeof chunk.file_path === "string" && chunk.file_path
					? { path: chunk.file_path }
					: {}),
			}));
		}
		return records;
	} finally {
		db.close();
	}
}

export async function migrateContextMode(input: {
	projectDir: string;
	sanitize: (content: string) => string;
	legacyRoot?: string;
}): Promise<MigrationResult> {
	const store = await readStore(input.projectDir);
	if (store.migrations[MIGRATION_NAME]) {
		return {
			alreadyMigrated: true,
			recordsImported: store.migrations[MIGRATION_NAME].recordsImported,
			sourceFiles: store.migrations[MIGRATION_NAME].sourceFiles,
			sessionDatabases: 0,
			contentDatabases: 0,
			skippedDatabases: 0,
		};
	}

	const root = resolve(
		input.legacyRoot ?? join(homedir(), ".pi", "context-mode"),
	);
	const sessionFiles = await databaseFiles(join(root, "sessions"));
	const records: ContextRecord[] = [];
	const matchingBasenames = new Set<string>();
	let sessionDatabases = 0;
	let contentDatabases = 0;
	let skippedDatabases = 0;
	for (const path of sessionFiles) {
		try {
			const result = await readLegacySessionDatabase(
				path,
				input.projectDir,
				input.sanitize,
			);
			if (!result.matches) {
				skippedDatabases++;
				continue;
			}
			sessionDatabases++;
			matchingBasenames.add(basename(path));
			records.push(...result.records);
		} catch {
			skippedDatabases++;
		}
	}

	for (const name of matchingBasenames) {
		const path = join(root, "content", name);
		try {
			const imported = await readLegacyContentDatabase(path, input.sanitize);
			records.push(...imported);
			contentDatabases++;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				skippedDatabases++;
			}
		}
	}

	const sourceFiles = sessionDatabases + contentDatabases;
	const recordsImported = await replaceLegacyMigration(
		input.projectDir,
		MIGRATION_NAME,
		records,
		sourceFiles,
	);
	return {
		alreadyMigrated: false,
		recordsImported,
		sourceFiles,
		sessionDatabases,
		contentDatabases,
		skippedDatabases,
	};
}

export { MIGRATION_NAME };
