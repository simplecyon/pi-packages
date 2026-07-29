import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const MAX_FILES = 20;
const MAX_OUTPUT_CHARS = 32 * 1024 * 1024;

export type ContextLanguage = "javascript" | "python";

export interface ContextRunInput {
	language: ContextLanguage;
	code: string;
	files?: string[];
	timeoutSeconds?: number;
}

export interface ContextRunResult {
	text: string;
	exitCode: number;
	killed: boolean;
	language: ContextLanguage;
	fileCount: number;
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolveProjectFiles(
	projectDir: string,
	paths: readonly string[],
): Promise<string[]> {
	if (paths.length > MAX_FILES) {
		throw new Error(`context_run accepts at most ${MAX_FILES} files`);
	}
	const root = await realpath(resolve(projectDir));
	const resolved: string[] = [];
	for (const path of paths) {
		const candidate = resolve(root, path);
		const candidateStat = await lstat(candidate);
		if (candidateStat.isSymbolicLink()) {
			throw new Error(`Symlink file inputs are not allowed: ${path}`);
		}
		const canonical = await realpath(candidate);
		if (!isWithin(root, canonical)) {
			throw new Error(`File escapes the project boundary: ${path}`);
		}
		const stat = await lstat(canonical);
		if (!stat.isFile()) {
			throw new Error(`Not a regular project file: ${path}`);
		}
		resolved.push(canonical);
	}
	return [...new Set(resolved)];
}

function javascriptWrapper(code: string, files: readonly string[]): string {
	return [
		'import fs from "node:fs";',
		`const FILE_PATHS = ${JSON.stringify(files)};`,
		"const FILES = Object.freeze(Object.fromEntries(FILE_PATHS.map((path) => [path, fs.readFileSync(path, \"utf8\")])));",
		"const FILE_CONTENT = FILE_PATHS.length > 0 ? FILES[FILE_PATHS[0]] : undefined;",
		code,
	].join("\n");
}

function pythonWrapper(code: string, files: readonly string[]): string {
	return [
		"from pathlib import Path",
		`FILE_PATHS = ${JSON.stringify(files)}`,
		"FILES = {path: Path(path).read_text(encoding='utf-8') for path in FILE_PATHS}",
		"FILE_CONTENT = FILES[FILE_PATHS[0]] if FILE_PATHS else None",
		code,
	].join("\n");
}

function renderExecResult(result: ExecResult): string {
	const parts: string[] = [];
	if (result.stdout) parts.push(result.stdout);
	if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
	const text = parts.join("\n").trimEnd() || "(no output)";
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	const head = text.slice(0, Math.floor(MAX_OUTPUT_CHARS * 0.65));
	const tail = text.slice(text.length - Math.floor(MAX_OUTPUT_CHARS * 0.35));
	return `${head}\n\n[… context_run output capped at ${MAX_OUTPUT_CHARS} characters …]\n\n${tail}`;
}

export async function runContextCode(
	pi: Pick<ExtensionAPI, "exec">,
	ctx: Pick<ExtensionContext, "cwd">,
	input: ContextRunInput,
	signal?: AbortSignal,
): Promise<ContextRunResult> {
	const files = await resolveProjectFiles(ctx.cwd, input.files ?? []);
	const timeout = Math.max(
		1_000,
		Math.min(120_000, Math.floor((input.timeoutSeconds ?? 30) * 1_000)),
	);
	const command = input.language === "javascript" ? process.execPath : "python3";
	const code =
		input.language === "javascript"
			? javascriptWrapper(input.code, files)
			: pythonWrapper(input.code, files);
	const args =
		input.language === "javascript"
			? ["--input-type=module", "-e", code]
			: ["-c", code];
	const result = await pi.exec(command, args, {
		cwd: ctx.cwd,
		timeout,
		signal,
	});
	const text = renderExecResult(result);
	if (result.code !== 0) {
		const bounded = text.length > 12_000
			? `${text.slice(0, 5_000)}\n[… error output omitted …]\n${text.slice(-5_000)}`
			: text;
		throw new Error(
			`context_run exited with code ${result.code}${
				result.killed ? " (killed)" : ""
			}\n${bounded}`,
		);
	}
	return {
		text,
		exitCode: result.code,
		killed: result.killed,
		language: input.language,
		fileCount: files.length,
	};
}
