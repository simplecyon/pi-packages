import type {
	ContextRecord,
	ContextSearchHit,
} from "./types.ts";

function tokenize(value: string): string[] {
	const normalized = value.toLocaleLowerCase();
	const tokens: string[] = normalized.match(/[a-z0-9_./:-]+/g) ?? [];
	const cjk = [...normalized].filter((char) =>
		/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)
	);
	tokens.push(...cjk);
	for (let index = 0; index + 1 < cjk.length; index++) {
		tokens.push(`${cjk[index]}${cjk[index + 1]}`);
	}
	return tokens.filter(Boolean);
}

function termCounts(record: ContextRecord): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokenize(`${record.title}\n${record.content}`)) {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
}

function snippet(text: string, query: string, maxChars = 1_200): string {
	if (text.length <= maxChars) return text;
	const haystack = text.toLocaleLowerCase();
	const candidates = [query.toLocaleLowerCase(), ...tokenize(query)];
	let match = -1;
	for (const candidate of candidates) {
		const index = haystack.indexOf(candidate);
		if (index >= 0 && (match < 0 || index < match)) match = index;
	}
	const center = match < 0 ? 0 : match;
	const start = Math.max(
		0,
		Math.min(center - Math.floor(maxChars / 3), text.length - maxChars),
	);
	const end = Math.min(text.length, start + maxChars);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${
		end < text.length ? "…" : ""
	}`;
}

export function searchRecords(
	records: readonly ContextRecord[],
	query: string,
	options?: {
		limit?: number;
		source?: string;
		kinds?: string[];
	},
): ContextSearchHit[] {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0) return [];
	const filtered = records.filter((record) => {
		if (options?.source && record.source !== options.source) return false;
		if (options?.kinds?.length && !options.kinds.includes(record.kind)) return false;
		return true;
	});
	if (filtered.length === 0) return [];

	const documents = filtered.map((record) => ({
		record,
		counts: termCounts(record),
		length: Math.max(1, tokenize(`${record.title}\n${record.content}`).length),
	}));
	const averageLength =
		documents.reduce((total, document) => total + document.length, 0) /
		documents.length;
	const documentFrequency = new Map<string, number>();
	for (const token of queryTokens) {
		documentFrequency.set(
			token,
			documents.filter((document) => document.counts.has(token)).length,
		);
	}

	const hits: ContextSearchHit[] = [];
	for (const document of documents) {
		let score = 0;
		for (const token of queryTokens) {
			const frequency = document.counts.get(token) ?? 0;
			if (frequency === 0) continue;
			const df = documentFrequency.get(token) ?? 0;
			const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
			const denominator =
				frequency +
				1.2 * (1 - 0.75 + 0.75 * (document.length / averageLength));
			score += idf * ((frequency * 2.2) / denominator);
		}
		const combined = `${document.record.title}\n${document.record.content}`
			.toLocaleLowerCase();
		if (combined.includes(query.toLocaleLowerCase())) score += 4;
		if (score <= 0) continue;
		hits.push({
			id: document.record.id,
			kind: document.record.kind,
			source: document.record.source,
			title: document.record.title,
			createdAt: document.record.createdAt,
			score,
			snippet: snippet(document.record.content, query),
			...(document.record.category
				? { category: document.record.category }
				: {}),
			...(document.record.eventType
				? { eventType: document.record.eventType }
				: {}),
		});
	}
	return hits
		.sort((a, b) =>
			b.score - a.score ||
			b.createdAt.localeCompare(a.createdAt) ||
			a.id.localeCompare(b.id)
		)
		.slice(0, Math.max(1, Math.min(options?.limit ?? 5, 20)));
}
