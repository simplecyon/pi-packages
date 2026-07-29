import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MEMORY_FILENAMES = ["MEMORY.md", "MEMORY.MD"] as const;
export const DEFAULT_MAX_MEMORY_CHARS = 12_000;

export interface MemoryFile {
	path: string;
	scopeDir: string;
	content: string;
	hash: string;
	truncated: boolean;
}

export interface BaseSnapshot {
	files: MemoryFile[];
	projectRoot: string;
	signature: string;
}

export function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function truncateMemory(
	content: string,
	maxChars = DEFAULT_MAX_MEMORY_CHARS,
): { content: string; truncated: boolean } {
	if (content.length <= maxChars) return { content, truncated: false };
	const marker = "\n\n<!-- memory truncated: middle omitted -->\n\n";
	const available = Math.max(0, maxChars - marker.length);
	const headLength = Math.ceil(available * 0.7);
	const tailLength = available - headLength;
	return {
		content: `${content.slice(0, headLength)}${marker}${content.slice(-tailLength)}`,
		truncated: true,
	};
}

export function loadMemoryFromDir(
	dir: string,
	maxChars = DEFAULT_MAX_MEMORY_CHARS,
): MemoryFile | null {
	for (const filename of MEMORY_FILENAMES) {
		const filePath = path.join(dir, filename);
		try {
			if (!fs.statSync(filePath).isFile()) continue;
			const raw = fs.readFileSync(filePath, "utf8");
			const bounded = truncateMemory(raw, maxChars);
			return {
				path: filePath,
				scopeDir: path.resolve(dir),
				content: bounded.content,
				hash: hashText(raw),
				truncated: bounded.truncated,
			};
		} catch {
			// Missing or unreadable candidates are skipped.
		}
	}
	return null;
}

export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	while (true) {
		if (
			fs.existsSync(path.join(dir, ".pi", "settings.json")) ||
			fs.existsSync(path.join(dir, ".git"))
		) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

export function isWithin(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function resolveToolPath(value: unknown, cwd: string): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		return path.resolve(cwd, value);
	} catch {
		return null;
	}
}

function targetStartDir(targetPath: string): string {
	try {
		return fs.statSync(targetPath).isDirectory()
			? targetPath
			: path.dirname(targetPath);
	} catch {
		return path.dirname(targetPath);
	}
}

export function findNearestScopeMemory(
	targetPath: string,
	projectRoot: string,
	maxChars = DEFAULT_MAX_MEMORY_CHARS,
): MemoryFile | null {
	const root = path.resolve(projectRoot);
	const target = path.resolve(targetPath);
	if (!isWithin(root, target)) return null;

	let dir = targetStartDir(target);
	while (isWithin(root, dir) && dir !== root) {
		const memory = loadMemoryFromDir(dir, maxChars);
		if (memory) return memory;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function loadBaseSnapshot(
	cwd: string,
	agentDir: string,
	maxChars = DEFAULT_MAX_MEMORY_CHARS,
): BaseSnapshot {
	const projectRoot = findProjectRoot(cwd);
	const files: MemoryFile[] = [];
	const seen = new Set<string>();
	const add = (memory: MemoryFile | null) => {
		if (!memory || seen.has(memory.path)) return;
		seen.add(memory.path);
		files.push(memory);
	};

	add(loadMemoryFromDir(agentDir, maxChars));
	add(loadMemoryFromDir(projectRoot, maxChars));
	if (path.resolve(cwd) !== projectRoot) {
		add(findNearestScopeMemory(cwd, projectRoot, maxChars));
	}

	const signature = hashText(
		files.map((file) => `${file.path}\0${file.hash}`).join("\0"),
	);
	return { files, projectRoot, signature };
}

export function isSamePath(left: string, right: string): boolean {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

export function looksMutatingBash(command: string): boolean {
	return (
		/(^|[;&|]\s*)(?:sudo\s+)?(?:rm|mv|cp|mkdir|rmdir|touch|install|ln|chmod|chown|truncate)\b/m.test(command) ||
		/(^|[;&|]\s*)(?:sudo\s+)?(?:sed|perl)\b[^\n;&|]*\s-i(?:\s|$)/m.test(command) ||
		/(^|[;&|]\s*)(?:sudo\s+)?(?:tee|dd)\b/m.test(command) ||
		/(?:^|[^<>])>{1,2}(?![>&])/m.test(command) ||
		/\bgit\s+(?:add|commit|reset|checkout|switch|clean|restore|rebase|merge|cherry-pick|revert|apply|am)\b/m.test(command)
	);
}

export function extractBashPaths(command: string, cwd: string): string[] {
	const paths = new Set<string>();
	const add = (candidate: string) => {
		if (
			candidate === "." ||
			candidate === ".." ||
			candidate.includes("/") ||
			candidate.includes("\\")
		) {
			const resolved = resolveToolPath(candidate, cwd);
			if (resolved) paths.add(resolved);
		}
	};

	for (const match of command.matchAll(/(["'])(.*?)\1/g)) add(match[2]);
	for (
		const token of command.match(
			/(?:\/|~\/|\.{1,2}\/|[A-Za-z0-9._~-]+\/)[A-Za-z0-9._~/-]+/g,
		) ?? []
	) {
		add(token.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~"));
	}
	return [...paths];
}
