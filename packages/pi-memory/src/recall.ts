import fs from "node:fs";
import path from "node:path";
import {
	hashText,
	isWithin,
	truncateMemory,
} from "./memory.ts";

export const DEFAULT_MAX_DISCRETE_FILES = 200;
export const DEFAULT_MAX_DISCRETE_FILE_BYTES = 64 * 1024;
export const DEFAULT_RECALL_BUDGET_CHARS = 8_000;
export const DEFAULT_RECALL_LIMIT = 2;
export const DEFAULT_AUTO_MIN_SCORE = 8;

const GENERIC_INPUTS = new Set([
	"continue",
	"继续",
	"好的",
	"好",
	"可以",
	"看看",
	"看看这个",
	"这个",
	"一下",
	"ok",
	"okay",
	"yes",
	"no",
]);

const STOP_WORDS = new Set([
	"about",
	"and",
	"for",
	"from",
	"into",
	"the",
	"this",
	"with",
	"一个",
	"一下",
	"什么",
	"可以",
	"如何",
	"怎么",
	"我们",
	"这个",
	"那个",
	"需要",
]);

export interface DiscreteMemoryFile {
	path: string;
	relativePath: string;
	scopeDir: string;
	title: string;
	triggers: string;
	useWhen: string;
	headings: string;
	content: string;
	hash: string;
	size: number;
}

export interface RecallHit {
	memory: DiscreteMemoryFile;
	score: number;
	reasons: string[];
	snippet: string;
}

export interface RecallSelection {
	query: string;
	hits: RecallHit[];
	content: string;
	signature: string;
	truncated: boolean;
}

interface CatalogOptions {
	maxFiles?: number;
	maxFileBytes?: number;
}

interface SearchOptions {
	limit?: number;
	minScore?: number;
	minMatchedTokens?: number;
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: Iterable<string>): string[] {
	return [...new Set([...values].filter(Boolean))];
}

export function tokenizeRecallText(value: string): string[] {
	const normalized = normalize(value);
	const tokens: string[] = [];
	for (const raw of normalized.match(/[a-z0-9][a-z0-9_./:+-]*/g) ?? []) {
		tokens.push(raw);
		tokens.push(...raw.split(/[._/:+-]+/g));
	}
	for (
		const sequence of normalized.match(
			/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
		) ?? []
	) {
		if (sequence.length >= 2 && sequence.length <= 16) tokens.push(sequence);
		for (let index = 0; index + 1 < sequence.length; index += 1) {
			tokens.push(sequence.slice(index, index + 2));
		}
	}
	return unique(
		tokens.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
	);
}

export function shouldAutoRecall(input: string): boolean {
	const normalized = normalize(input);
	if (!normalized || normalized.startsWith("/")) return false;
	if (GENERIC_INPUTS.has(normalized)) return false;
	return tokenizeRecallText(normalized).length > 0;
}

function titleFromContent(content: string, fallback: string): string {
	const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
	return heading || fallback.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

function headingsFromContent(content: string): string {
	return [...content.matchAll(/^#{1,6}\s+(.+)$/gm)]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value))
		.join("\n");
}

function parseIndexMetadata(
	indexContent: string,
	relativeMemoryPath: string,
): { title?: string; triggers: string; useWhen: string } {
	const slashPath = `.memory/${relativeMemoryPath.replaceAll(path.sep, "/")}`;
	const lines = indexContent.split(/\r?\n/);
	const lineIndex = lines.findIndex((line) => line.includes(slashPath));
	if (lineIndex < 0) return { triggers: "", useWhen: "" };

	const firstLine = lines[lineIndex] ?? "";
	const baseIndent = firstLine.match(/^\s*/)?.[0].length ?? 0;
	const title = firstLine
		.replace(/^\s*-\s*/, "")
		.split(/:\s+see\b|：\s*see\b|\s+see\s+`?\.memory\//i)[0]
		?.replace(/[*_`]/g, "")
		.trim();
	let triggers = "";
	let useWhen = "";
	for (let index = lineIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (/^\s*-\s+/.test(line) && indent <= baseIndent) break;
		if (/^#{1,6}\s/.test(line)) break;
		const triggerMatch = /^\s*-\s*triggers\s*:\s*(.+)$/i.exec(line);
		if (triggerMatch) triggers = triggerMatch[1]?.trim() ?? "";
		const useWhenMatch = /^\s*-\s*use when\s*:\s*(.+)$/i.exec(line);
		if (useWhenMatch) useWhen = useWhenMatch[1]?.trim() ?? "";
	}
	return { title, triggers, useWhen };
}

function memoryDirs(projectRoot: string, cwd: string): string[] {
	const root = path.resolve(projectRoot);
	let current = path.resolve(cwd);
	if (!isWithin(root, current)) current = root;
	const dirs: string[] = [];
	while (isWithin(root, current)) {
		dirs.push(path.join(current, ".memory"));
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return unique(dirs.reverse());
}

function listMarkdownFiles(
	memoryDir: string,
	remaining: number,
): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		if (files.length >= remaining) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= remaining || entry.isSymbolicLink()) continue;
			const candidate = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(candidate);
			} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
				files.push(candidate);
			}
		}
	};
	visit(memoryDir);
	return files;
}

export function discoverDiscreteMemories(
	cwd: string,
	projectRoot: string,
	options: CatalogOptions = {},
): DiscreteMemoryFile[] {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_DISCRETE_FILES;
	const maxFileBytes =
		options.maxFileBytes ?? DEFAULT_MAX_DISCRETE_FILE_BYTES;
	const result: DiscreteMemoryFile[] = [];
	for (const memoryDir of memoryDirs(projectRoot, cwd)) {
		if (result.length >= maxFiles) break;
		let memoryDirStat: fs.Stats;
		try {
			memoryDirStat = fs.lstatSync(memoryDir);
		} catch {
			continue;
		}
		if (!memoryDirStat.isDirectory() || memoryDirStat.isSymbolicLink()) continue;
		let realMemoryDir: string;
		try {
			realMemoryDir = fs.realpathSync(memoryDir);
		} catch {
			continue;
		}
		const scopeDir = path.dirname(memoryDir);
		let indexContent = "";
		try {
			indexContent = fs.readFileSync(path.join(scopeDir, "MEMORY.md"), "utf8");
		} catch {
			// An unindexed .memory directory stays searchable by its own content.
		}
		for (const filePath of listMarkdownFiles(memoryDir, maxFiles - result.length)) {
			try {
				const stat = fs.lstatSync(filePath);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.size > maxFileBytes
				) {
					continue;
				}
				const realPath = fs.realpathSync(filePath);
				if (!isWithin(realMemoryDir, realPath)) continue;
				const content = fs.readFileSync(filePath, "utf8");
				const relativeMemoryPath = path.relative(memoryDir, filePath);
				const metadata = parseIndexMetadata(indexContent, relativeMemoryPath);
				result.push({
					path: filePath,
					relativePath: path.relative(projectRoot, filePath),
					scopeDir,
					title:
						metadata.title ||
						titleFromContent(content, path.basename(filePath)),
					triggers: metadata.triggers,
					useWhen: metadata.useWhen,
					headings: headingsFromContent(content),
					content,
					hash: hashText(content),
					size: stat.size,
				});
			} catch {
				// Files changed or became unreadable during discovery; skip them.
			}
		}
	}
	return result;
}

function snippet(content: string, query: string, maxChars = 1_200): string {
	if (content.length <= maxChars) return content;
	const normalized = normalize(content);
	const candidates = [normalize(query), ...tokenizeRecallText(query)];
	let match = -1;
	for (const candidate of candidates) {
		const index = normalized.indexOf(candidate);
		if (index >= 0 && (match < 0 || index < match)) match = index;
	}
	const center = match < 0 ? 0 : match;
	const start = Math.max(
		0,
		Math.min(center - Math.floor(maxChars / 3), content.length - maxChars),
	);
	const end = Math.min(content.length, start + maxChars);
	return `${start > 0 ? "…" : ""}${content.slice(start, end)}${
		end < content.length ? "…" : ""
	}`;
}

function scoreField(
	query: string,
	queryTokens: readonly string[],
	value: string,
	tokenWeight: number,
	phraseWeight: number,
): number {
	if (!value) return 0;
	const normalizedValue = normalize(value);
	const fieldTokens = new Set(tokenizeRecallText(normalizedValue));
	let score = 0;
	if (normalize(query).length >= 2 && normalizedValue.includes(normalize(query))) {
		score += phraseWeight;
	}
	for (const token of queryTokens) {
		if (fieldTokens.has(token)) {
			score += tokenWeight;
		}
	}
	return score;
}

export function searchDiscreteMemories(
	memories: readonly DiscreteMemoryFile[],
	query: string,
	options: SearchOptions = {},
): RecallHit[] {
	const tokens = tokenizeRecallText(query);
	if (tokens.length === 0) return [];
	const hits: RecallHit[] = [];
	for (const memory of memories) {
		const fields = [
			["title", memory.title, 5, 7],
			["triggers", memory.triggers, 6, 8],
			["use when", memory.useWhen, 4, 6],
			["headings", memory.headings, 3, 5],
			["content", memory.content, 1, 2],
		] as const;
		let score = 0;
		const reasons: string[] = [];
		for (const [label, value, tokenWeight, phraseWeight] of fields) {
			const fieldScore = scoreField(
				query,
				tokens,
				value,
				tokenWeight,
				phraseWeight,
			);
			if (fieldScore > 0) {
				score += fieldScore;
				reasons.push(`${label} +${fieldScore}`);
			}
		}
		const searchableTokens = new Set(
			tokenizeRecallText(fields.map((field) => field[1]).join("\n")),
		);
		const matchedTokenCount = tokens.filter((token) =>
			searchableTokens.has(token),
		).length;
		const requiredMatches = Math.min(
			options.minMatchedTokens ?? 2,
			tokens.length,
		);
		if (matchedTokenCount < requiredMatches) continue;
		if (score < (options.minScore ?? DEFAULT_AUTO_MIN_SCORE)) continue;
		hits.push({
			memory,
			score,
			reasons,
			snippet: snippet(memory.content, query),
		});
	}
	return hits
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.memory.relativePath.localeCompare(right.memory.relativePath),
		)
		.slice(0, Math.max(1, Math.min(options.limit ?? 5, 20)));
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function selectRecall(
	query: string,
	hits: readonly RecallHit[],
	options: { limit?: number; maxChars?: number } = {},
): RecallSelection | null {
	const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
	const maxChars = options.maxChars ?? DEFAULT_RECALL_BUDGET_CHARS;
	const selected = hits.slice(0, Math.max(1, limit));
	if (selected.length === 0) return null;
	const opening = `<memory_recall query="${escapeAttribute(query)}">\n`;
	const closing = "</memory_recall>";
	let remaining = maxChars - opening.length - closing.length;
	let truncated = false;
	const rendered: string[] = [];
	const kept: RecallHit[] = [];
	for (const hit of selected) {
		const header =
			`<file path="${escapeAttribute(hit.memory.relativePath)}" ` +
			`score="${hit.score}" reasons="${escapeAttribute(hit.reasons.join(", "))}">\n`;
		const footer = "\n</file>\n";
		const allowance = remaining - header.length - footer.length;
		if (allowance < 200) {
			truncated = true;
			break;
		}
		const bounded = truncateMemory(hit.memory.content, allowance);
		rendered.push(`${header}${bounded.content}${footer}`);
		kept.push(hit);
		remaining -= header.length + bounded.content.length + footer.length;
		truncated ||= bounded.truncated;
	}
	if (kept.length === 0) return null;
	const content = `${opening}${rendered.join("")}${closing}`;
	const signature = hashText(
		`${normalize(query)}\0${kept
			.map((hit) => `${hit.memory.path}\0${hit.memory.hash}`)
			.join("\0")}`,
	);
	return { query, hits: kept, content, signature, truncated };
}

export function formatRecallSearch(hits: readonly RecallHit[]): string {
	if (hits.length === 0) return "No matching discrete project memory found.";
	return hits
		.map(
			(hit, index) =>
				[
					`${index + 1}. ${hit.memory.relativePath} · score ${hit.score}`,
					`   Match: ${hit.reasons.join(", ")}`,
					`   ${hit.snippet.replace(/\s+/g, " ").trim()}`,
				].join("\n"),
		)
		.join("\n\n");
}
