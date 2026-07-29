import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistorySegment, StoredCheckpoint } from "./types.ts";

export function storageRoot(): string {
	return process.env.PI_CONTEXT_COMPACT_DIR || join(homedir(), ".pi", "agent", "context-compact");
}

export function sessionKey(sessionRef: string): string {
	return createHash("sha256").update(sessionRef).digest("hex").slice(0, 24);
}

function sessionDir(sessionRef: string): string {
	return join(storageRoot(), "sessions", sessionKey(sessionRef));
}

export async function appendSegment(segment: HistorySegment): Promise<void> {
	const dir = sessionDir(segment.sessionRef);
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, "history.jsonl"), `${JSON.stringify(segment)}\n`, "utf8");
}

export async function appendCheckpoint(sessionRef: string, checkpoint: StoredCheckpoint): Promise<void> {
	const dir = sessionDir(sessionRef);
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, "checkpoints.jsonl"), `${JSON.stringify(checkpoint)}\n`, "utf8");
}

export async function readSegments(sessionRef: string): Promise<HistorySegment[]> {
	let raw: string;
	try {
		raw = await readFile(join(sessionDir(sessionRef), "history.jsonl"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const segments: HistorySegment[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Partial<HistorySegment>;
			if (value.type === "segment" && Array.isArray(value.messages) && typeof value.id === "string") {
				segments.push(value as HistorySegment);
			}
		} catch {
			// Ignore a partially written or externally corrupted line; other
			// append-only records remain searchable.
		}
	}
	return segments;
}
