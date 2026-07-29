import { readSegments } from "./storage.ts";
import type { SearchHit } from "./types.ts";

function tokens(value: string): string[] {
	const normalized = value.toLocaleLowerCase();
	const result: string[] = normalized.match(/[a-z0-9_./:-]+/g) ?? [];
	const cjk = [...normalized].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
	for (const char of cjk) result.push(char);
	for (let index = 0; index + 1 < cjk.length; index += 1) {
		result.push(`${cjk[index]}${cjk[index + 1]}`);
	}
	return [...new Set(result.filter((token) => token.length > 0))];
}

function scoreText(query: string, text: string): number {
	const queryTokens = tokens(query);
	if (queryTokens.length === 0) return 0;
	const haystack = text.toLocaleLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		let cursor = 0;
		let count = 0;
		while ((cursor = haystack.indexOf(token, cursor)) !== -1) {
			count += 1;
			cursor += token.length;
		}
		if (count > 0) score += 1 + Math.log2(count);
	}
	if (haystack.includes(query.toLocaleLowerCase())) score += 5;
	return score;
}

function boundedSnippet(text: string, query: string, maxChars = 1600): string {
	if (text.length <= maxChars) return text;
	const normalized = text.toLocaleLowerCase();
	const candidates = [query.toLocaleLowerCase(), ...tokens(query)].filter(Boolean);
	let matchIndex = -1;
	for (const candidate of candidates) {
		const index = normalized.indexOf(candidate);
		if (index >= 0 && (matchIndex < 0 || index < matchIndex)) matchIndex = index;
	}
	const center = matchIndex >= 0 ? matchIndex : 0;
	const start = Math.max(0, Math.min(center - Math.floor(maxChars / 3), text.length - maxChars));
	const end = Math.min(text.length, start + maxChars);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export async function searchHistory(sessionRef: string, query: string, limit = 5): Promise<SearchHit[]> {
	const segments = await readSegments(sessionRef);
	const hits: SearchHit[] = [];
	for (const segment of segments) {
		for (const message of segment.messages) {
			if (!message.text) continue;
			const score = scoreText(query, message.text);
			if (score <= 0) continue;
			hits.push({
				segmentId: segment.id,
				createdAt: segment.createdAt,
				role: message.role,
				text: boundedSnippet(message.text, query),
				score,
			});
		}
	}
	return hits
		.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
		.slice(0, Math.max(1, Math.min(limit, 20)));
}
