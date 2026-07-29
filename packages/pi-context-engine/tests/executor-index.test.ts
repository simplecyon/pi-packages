import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runContextCode, resolveProjectFiles } from "../src/executor.ts";
import { indexContent, indexPath } from "../src/indexer.ts";
import { readStore } from "../src/storage.ts";

test("runs file-heavy JavaScript while returning only derived output", async (t) => {
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-run-"));
	t.after(() => rm(projectDir, { recursive: true, force: true }));
	await writeFile(join(projectDir, "numbers.txt"), "1\n2\n3\n4\n", "utf8");
	const exec = async (
		command: string,
		args: string[],
		options: { cwd?: string; timeout?: number; signal?: AbortSignal },
	) => {
		const { execFile } = await import("node:child_process");
		return new Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}>((resolve) => {
			execFile(command, args, {
				cwd: options.cwd,
				timeout: options.timeout,
				signal: options.signal,
				maxBuffer: 40 * 1024 * 1024,
			}, (error, stdout, stderr) => {
				resolve({
					stdout,
					stderr,
					code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
					killed: Boolean(error?.killed),
				});
			});
		});
	};
	const result = await runContextCode(
		{ exec } as never,
		{ cwd: projectDir },
		{
			language: "javascript",
			files: ["numbers.txt"],
			code: "console.log(FILE_CONTENT.trim().split(/\\s+/).map(Number).reduce((a,b)=>a+b,0))",
		},
	);
	assert.equal(result.text, "10");
	assert.equal(result.fileCount, 1);
	assert.doesNotMatch(result.text, /1\n2\n3/);
});

test("rejects files outside the project and direct symlink inputs", async (t) => {
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-boundary-"));
	const outsideDir = await mkdtemp(join(tmpdir(), "pi-context-outside-"));
	t.after(async () => {
		await rm(projectDir, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	});
	await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");
	await symlink(join(outsideDir, "secret.txt"), join(projectDir, "link.txt"));
	await assert.rejects(
		resolveProjectFiles(projectDir, ["../does-not-belong.txt"]),
	);
	await assert.rejects(
		resolveProjectFiles(projectDir, ["link.txt"]),
		/Symlink file inputs are not allowed/,
	);
});

test("indexes redacted content and replaces a stable source", async (t) => {
	const storeRoot = await mkdtemp(join(tmpdir(), "pi-context-index-store-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-context-index-project-"));
	const previous = process.env.PI_CONTEXT_ENGINE_DIR;
	process.env.PI_CONTEXT_ENGINE_DIR = storeRoot;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ENGINE_DIR;
		else process.env.PI_CONTEXT_ENGINE_DIR = previous;
		await rm(storeRoot, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});
	await writeFile(join(projectDir, "notes.md"), "# Decision\napi_key=secret\nkeep this", "utf8");
	const sanitize = (value: string) => value.replace(/secret/g, "[REDACTED]");
	await indexPath({ projectDir, path: "notes.md", source: "notes", sanitize });
	await indexContent({
		projectDir,
		source: "notes",
		content: "replacement secret",
		sanitize,
	});
	const store = await readStore(projectDir);
	assert.equal(store.records.length, 1);
	assert.equal(store.records[0].content, "replacement [REDACTED]");
	assert.doesNotMatch(JSON.stringify(store), /api_key=secret/);
});
