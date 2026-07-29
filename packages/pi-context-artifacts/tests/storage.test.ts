import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	listArtifacts,
	readArtifact,
	writeArtifact,
} from "../src/storage.ts";

test("stores and recovers exact text without tool arguments", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-artifacts-storage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previous = process.env.PI_CONTEXT_ARTIFACTS_DIR;
	process.env.PI_CONTEXT_ARTIFACTS_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CONTEXT_ARTIFACTS_DIR;
		else process.env.PI_CONTEXT_ARTIFACTS_DIR = previous;
	});

	const source = "exact redacted result\n".repeat(200);
	const summary = await writeArtifact(
		"session-a",
		"read",
		[{ type: "text", text: source }],
		1000,
	);
	const record = await readArtifact("session-a", summary.id);
	assert.equal(record?.content[0]?.text, source);
	assert.equal(JSON.stringify(record).includes("arguments"), false);
	assert.deepEqual((await listArtifacts("session-a")).map((item) => item.id), [summary.id]);
	assert.equal(await readArtifact("session-b", summary.id), undefined);
});
