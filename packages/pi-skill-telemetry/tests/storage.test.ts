import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadIdentity, readLocalEvents, TelemetryWriter } from "../src/storage.ts";
import { summarizeEvents } from "../src/summary.ts";

test("writes immutable sealed segments and keeps install identity stable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skill-telemetry-"));
	try {
		const writer = await TelemetryWriter.create(root);
		await writer.record({
			event_type: "skill_invocation_detected",
			skill_id: "skill:demo",
			skill_name: "demo",
			trigger_mode: "model_read",
			confidence: "high",
			invocation_id: "invoke-1",
			global_session_id: "session-1",
		});
		await writer.record({
			event_type: "skill_load_completed",
			skill_id: "skill:demo",
			skill_name: "demo",
			trigger_mode: "model_read",
			confidence: "high",
			invocation_id: "invoke-1",
			load_success: true,
		});
		const segment = await writer.seal();
		if (!segment) throw new Error("expected a sealed segment");
		assert.ok(segment.endsWith(".jsonl"));
		const lines = (await readFile(segment, "utf8")).trim().split("\n");
		const seal = JSON.parse(lines.at(-1) ?? "{}");
		assert.equal(seal.event_type, "segment_seal");
		assert.equal(seal.event_count, 2);
		assert.match(seal.payload_sha256, /^[0-9a-f]{64}$/);

		const events = await readLocalEvents(root);
		const rows = summarizeEvents(events);
		assert.equal(rows[0]?.skill_name, "demo");
		assert.equal(rows[0]?.invocations, 1);
		assert.equal(rows[0]?.load_successes, 1);

		const first = await loadIdentity(root);
		const second = await loadIdentity(root);
		assert.equal(first.install_id, second.install_id);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
