import { createRecord } from "./storage.ts";
import type {
	ContextRecord,
	ContextRecordKind,
} from "./types.ts";

const DEFAULT_CHUNK_CHARS = 4_000;
const OVERLAP_CHARS = 240;

function normalizedTitle(value: string, fallback: string): string {
	const title = value.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
	return (title || fallback).slice(0, 240);
}

function splitLargeBlock(block: string, maxChars: number): string[] {
	if (block.length <= maxChars) return [block];
	const chunks: string[] = [];
	let offset = 0;
	while (offset < block.length) {
		let end = Math.min(block.length, offset + maxChars);
		if (end < block.length) {
			const newline = block.lastIndexOf("\n", end);
			if (newline > offset + Math.floor(maxChars / 2)) end = newline;
		}
		chunks.push(block.slice(offset, end).trim());
		if (end >= block.length) break;
		offset = Math.max(offset + 1, end - OVERLAP_CHARS);
	}
	return chunks.filter(Boolean);
}

export function chunkText(input: {
	content: string;
	source: string;
	kind?: ContextRecordKind;
	path?: string;
	title?: string;
	createdAt?: string;
	sessionRef?: string;
	category?: string;
	eventType?: string;
	maxChars?: number;
}): ContextRecord[] {
	const content = input.content.replace(/\r\n/g, "\n").trim();
	if (!content) return [];
	const maxChars = Math.max(1_000, input.maxChars ?? DEFAULT_CHUNK_CHARS);
	const lines = content.split("\n");
	const sections: Array<{ title: string; body: string[] }> = [];
	let current = {
		title: normalizedTitle(input.title ?? input.source, input.source),
		body: [] as string[],
	};
	for (const line of lines) {
		if (/^#{1,6}\s+\S/.test(line) && current.body.some((item) => item.trim())) {
			sections.push(current);
			current = {
				title: normalizedTitle(line, input.source),
				body: [line],
			};
		} else {
			current.body.push(line);
		}
	}
	if (current.body.some((item) => item.trim())) sections.push(current);

	const records: ContextRecord[] = [];
	for (const section of sections) {
		const body = section.body.join("\n").trim();
		const pieces = splitLargeBlock(body, maxChars);
		for (const [index, piece] of pieces.entries()) {
			records.push(createRecord({
				kind: input.kind ?? "document",
				source: input.source,
				title:
					pieces.length > 1
						? `${section.title} · part ${index + 1}/${pieces.length}`
						: section.title,
				content: piece,
				...(input.createdAt ? { createdAt: input.createdAt } : {}),
				...(input.path ? { path: input.path } : {}),
				...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
				...(input.category ? { category: input.category } : {}),
				...(input.eventType ? { eventType: input.eventType } : {}),
			}));
		}
	}
	return records;
}
