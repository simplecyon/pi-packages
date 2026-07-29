import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	ContextRecord,
	ContextStore,
	StoreStats,
} from "./types.ts";

const STORE_VERSION = 1;
const MAX_RECORDS = 12_000;
const queues = new Map<string, Promise<unknown>>();

export function contextEngineRoot(): string {
	return process.env.PI_CONTEXT_ENGINE_DIR ||
		join(homedir(), ".pi", "agent", "context-engine");
}

export function canonicalProjectDir(projectDir: string): string {
	const absolute = resolve(projectDir);
	return process.platform === "darwin" || process.platform === "win32"
		? absolute.toLocaleLowerCase()
		: absolute;
}

export function projectKey(projectDir: string): string {
	return createHash("sha256")
		.update(canonicalProjectDir(projectDir))
		.digest("hex")
		.slice(0, 24);
}

export function projectStorePath(projectDir: string): string {
	return join(contextEngineRoot(), "projects", projectKey(projectDir), "store.json");
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function createRecord(
	input: Omit<ContextRecord, "version" | "id" | "contentHash" | "createdAt"> &
		Partial<Pick<ContextRecord, "id" | "createdAt">>,
): ContextRecord {
	return {
		version: 1,
		id: input.id ?? randomUUID(),
		kind: input.kind,
		source: input.source,
		title: input.title,
		content: input.content,
		createdAt: input.createdAt ?? new Date().toISOString(),
		contentHash: contentHash(input.content),
		...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
		...(input.path ? { path: input.path } : {}),
		...(input.category ? { category: input.category } : {}),
		...(input.eventType ? { eventType: input.eventType } : {}),
	};
}

function emptyStore(projectDir: string): ContextStore {
	return {
		version: STORE_VERSION,
		projectDir: resolve(projectDir),
		updatedAt: new Date().toISOString(),
		records: [],
		migrations: {},
	};
}

function isRecord(value: unknown): value is ContextRecord {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<ContextRecord>;
	return (
		item.version === 1 &&
		typeof item.id === "string" &&
		typeof item.kind === "string" &&
		typeof item.source === "string" &&
		typeof item.title === "string" &&
		typeof item.content === "string" &&
		typeof item.createdAt === "string" &&
		typeof item.contentHash === "string"
	);
}

export async function readStore(projectDir: string): Promise<ContextStore> {
	const path = projectStorePath(projectDir);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyStore(projectDir);
		}
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ContextStore>;
		if (
			parsed.version !== STORE_VERSION ||
			!Array.isArray(parsed.records) ||
			!parsed.records.every(isRecord)
		) {
			throw new Error("unsupported or corrupt context-engine store");
		}
		return {
			version: STORE_VERSION,
			projectDir:
				typeof parsed.projectDir === "string"
					? parsed.projectDir
					: resolve(projectDir),
			updatedAt:
				typeof parsed.updatedAt === "string"
					? parsed.updatedAt
					: new Date().toISOString(),
			records: parsed.records.slice(-MAX_RECORDS),
			migrations:
				parsed.migrations && typeof parsed.migrations === "object"
					? parsed.migrations
					: {},
		};
	} catch (error) {
		throw new Error(
			`Cannot read context-engine store ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function writeStore(projectDir: string, store: ContextStore): Promise<void> {
	const target = projectStorePath(projectDir);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const next: ContextStore = {
		...store,
		version: STORE_VERSION,
		projectDir: resolve(projectDir),
		updatedAt: new Date().toISOString(),
		records: store.records.slice(-MAX_RECORDS),
	};
	try {
		await writeFile(temporary, `${JSON.stringify(next)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(temporary, 0o600);
		await rename(temporary, target);
		await chmod(target, 0o600);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export async function updateStore<T>(
	projectDir: string,
	mutate: (store: ContextStore) => T | Promise<T>,
): Promise<T> {
	const key = projectStorePath(projectDir);
	const previous = queues.get(key) ?? Promise.resolve();
	let release: () => void = () => {};
	const current = new Promise<void>((resolveQueue) => {
		release = resolveQueue;
	});
	const queued = previous.then(() => current);
	queues.set(key, queued);
	await previous;
	try {
		const store = await readStore(projectDir);
		const result = await mutate(store);
		await writeStore(projectDir, store);
		return result;
	} finally {
		release();
		if (queues.get(key) === queued) queues.delete(key);
	}
}

function dedupeKey(record: ContextRecord): string {
	return record.id;
}

export async function appendRecords(
	projectDir: string,
	records: readonly ContextRecord[],
): Promise<number> {
	if (records.length === 0) return 0;
	return updateStore(projectDir, (store) => {
		const seen = new Set(store.records.map(dedupeKey));
		let added = 0;
		for (const record of records) {
			const key = dedupeKey(record);
			if (seen.has(key)) continue;
			store.records.push(record);
			seen.add(key);
			added++;
		}
		return added;
	});
}

export async function replaceSource(
	projectDir: string,
	source: string,
	records: readonly ContextRecord[],
): Promise<number> {
	return updateStore(projectDir, (store) => {
		store.records = store.records.filter((record) => record.source !== source);
		store.records.push(...records);
		return records.length;
	});
}

export async function replaceLegacyMigration(
	projectDir: string,
	name: string,
	records: readonly ContextRecord[],
	sourceFiles: number,
): Promise<number> {
	return updateStore(projectDir, (store) => {
		store.records = store.records.filter((record) =>
			record.kind !== "legacy-session" && record.kind !== "legacy-document"
		);
		store.records.push(...records);
		store.migrations[name] = {
			completedAt: new Date().toISOString(),
			recordsImported: records.length,
			sourceFiles,
		};
		return records.length;
	});
}

export async function purgeProjectStore(projectDir: string): Promise<boolean> {
	const target = projectStorePath(projectDir);
	try {
		await rm(target, { force: true });
		return true;
	} catch {
		return false;
	}
}

export function storeStats(store: ContextStore): StoreStats {
	const sources = new Set(store.records.map((record) => record.source));
	return {
		records: store.records.length,
		documents: store.records.filter((record) => record.kind === "document").length,
		sessionEvents: store.records.filter((record) => record.kind === "session").length,
		legacyRecords: store.records.filter((record) => record.kind.startsWith("legacy-")).length,
		sources: sources.size,
		characters: store.records.reduce(
			(total, record) => total + record.content.length,
			0,
		),
		migrations: Object.keys(store.migrations).sort(),
	};
}
