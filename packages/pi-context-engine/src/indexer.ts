import {
	lstat,
	readFile,
	readdir,
	realpath,
} from "node:fs/promises";
import {
	basename,
	extname,
	isAbsolute,
	relative,
	resolve,
} from "node:path";
import { chunkText } from "./chunk.ts";
import { fetchTextResource } from "./fetch.ts";
import { replaceSource } from "./storage.ts";
import type { ContextRecord } from "./types.ts";

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
	"",
	".c",
	".cc",
	".cpp",
	".css",
	".csv",
	".go",
	".h",
	".html",
	".java",
	".js",
	".json",
	".jsx",
	".log",
	".md",
	".mjs",
	".py",
	".rs",
	".sh",
	".sql",
	".svelte",
	".toml",
	".ts",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
]);

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function collectProjectFiles(
	projectDir: string,
	inputPath: string,
): Promise<string[]> {
	const root = await realpath(resolve(projectDir));
	const unresolved = resolve(root, inputPath);
	const unresolvedStat = await lstat(unresolved);
	if (unresolvedStat.isSymbolicLink()) {
		throw new Error("Symlink index targets are not allowed");
	}
	const candidate = await realpath(unresolved);
	if (!isWithin(root, candidate)) {
		throw new Error(`Index path escapes the project boundary: ${inputPath}`);
	}
	const stat = await lstat(candidate);
	if (stat.isFile()) return [candidate];
	if (!stat.isDirectory()) throw new Error(`Unsupported index target: ${inputPath}`);

	const files: string[] = [];
	const pending = [candidate];
	while (pending.length > 0 && files.length < MAX_FILES) {
		const directory = pending.shift()!;
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (
				entry.name === ".git" ||
				entry.name === "node_modules" ||
				entry.name.startsWith(".env")
			) {
				continue;
			}
			const path = resolve(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) {
				files.push(path);
				if (files.length >= MAX_FILES) break;
			}
		}
	}
	return files;
}

export async function preparePathRecords(input: {
	projectDir: string;
	path: string;
	source: string;
	sanitize: (content: string) => string;
}): Promise<ContextRecord[]> {
	const files = await collectProjectFiles(input.projectDir, input.path);
	let totalBytes = 0;
	const records: ContextRecord[] = [];
	for (const file of files) {
		const stat = await lstat(file);
		totalBytes += stat.size;
		if (totalBytes > MAX_TOTAL_BYTES) {
			throw new Error(`Index input exceeds ${MAX_TOTAL_BYTES} bytes`);
		}
		const raw = await readFile(file, "utf8");
		const content = input.sanitize(raw);
		const relativePath = relative(resolve(input.projectDir), file);
		records.push(...chunkText({
			content,
			source: input.source,
			title: relativePath || basename(file),
			path: relativePath || basename(file),
		}));
	}
	return records;
}

export async function indexContent(input: {
	projectDir: string;
	source: string;
	content: string;
	sanitize: (content: string) => string;
}): Promise<number> {
	const records = chunkText({
		content: input.sanitize(input.content),
		source: input.source,
	});
	return replaceSource(input.projectDir, input.source, records);
}

export async function indexPath(input: {
	projectDir: string;
	source: string;
	path: string;
	sanitize: (content: string) => string;
}): Promise<number> {
	const records = await preparePathRecords(input);
	return replaceSource(input.projectDir, input.source, records);
}

export async function indexUrl(input: {
	projectDir: string;
	source: string;
	url: string;
	sanitize: (content: string) => string;
	signal?: AbortSignal;
}): Promise<{ records: number; finalUrl: string; contentType: string }> {
	const fetched = await fetchTextResource(input.url, { signal: input.signal });
	const records = chunkText({
		content: input.sanitize(fetched.content),
		source: input.source,
		title: fetched.finalUrl,
		path: fetched.finalUrl,
	});
	await replaceSource(input.projectDir, input.source, records);
	return {
		records: records.length,
		finalUrl: fetched.finalUrl,
		contentType: fetched.contentType,
	};
}
