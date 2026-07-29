import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ArtifactRecord,
	ArtifactSummary,
	TextBlock,
} from "./types.ts";

const ARTIFACT_ID = /^art_[a-f0-9-]{36}$/;

export function artifactRoot(): string {
	return process.env.PI_CONTEXT_ARTIFACTS_DIR ??
		join(homedir(), ".pi", "agent", "context-artifacts");
}

export function sessionStorageKey(sessionRef: string): string {
	return createHash("sha256").update(sessionRef).digest("hex").slice(0, 32);
}

function sessionDirectory(sessionRef: string): string {
	return join(artifactRoot(), sessionStorageKey(sessionRef));
}

function recordPath(sessionRef: string, id: string): string {
	if (!ARTIFACT_ID.test(id)) throw new Error("Invalid artifact id");
	return join(sessionDirectory(sessionRef), `${id}.json`);
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ArtifactRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		ARTIFACT_ID.test(record.id) &&
		typeof record.createdAt === "string" &&
		typeof record.toolName === "string" &&
		Number.isSafeInteger(record.originalTokens) &&
		Number.isSafeInteger(record.originalCharacters) &&
		typeof record.sha256 === "string" &&
		Array.isArray(record.content) &&
		record.content.every((block) =>
			block?.type === "text" && typeof block.text === "string"
		)
	);
}

function summary(record: ArtifactRecord): ArtifactSummary {
	return {
		id: record.id,
		createdAt: record.createdAt,
		toolName: record.toolName,
		originalTokens: record.originalTokens,
		originalCharacters: record.originalCharacters,
		sha256: record.sha256,
	};
}

export function hashTextBlocks(content: readonly TextBlock[]): string {
	return createHash("sha256")
		.update(content.map((block) => block.text).join("\n"))
		.digest("hex");
}

export async function writeArtifact(
	sessionRef: string,
	toolName: string,
	content: TextBlock[],
	originalTokens: number,
): Promise<ArtifactSummary> {
	const id = `art_${randomUUID()}`;
	const joined = content.map((block) => block.text).join("\n");
	const record: ArtifactRecord = {
		version: 1,
		id,
		createdAt: new Date().toISOString(),
		toolName,
		originalTokens,
		originalCharacters: joined.length,
		sha256: hashTextBlocks(content),
		content,
	};
	const directory = sessionDirectory(sessionRef);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(recordPath(sessionRef, id), `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return summary(record);
}

export async function readArtifact(sessionRef: string, id: string): Promise<ArtifactRecord | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(recordPath(sessionRef, id), "utf8"));
		return isArtifactRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function listArtifacts(sessionRef: string): Promise<ArtifactSummary[]> {
	let names: string[];
	try {
		names = await readdir(sessionDirectory(sessionRef));
	} catch {
		return [];
	}
	const records = await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map((name) => readArtifact(sessionRef, name.slice(0, -5))),
	);
	return records
		.filter((record): record is ArtifactRecord => record !== undefined)
		.map(summary)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
