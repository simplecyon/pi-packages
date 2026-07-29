import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import skillTelemetryExtension from "../src/index.ts";
import { readLocalEvents } from "../src/storage.ts";

test("captures explicit and model-read skill invocations without storing content", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-skill-telemetry-extension-"));
	const skillDir = join(root, "skills", "demo");
	await mkdir(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\nDo the work.\n", "utf8");
	const previous = process.env.PI_SKILL_TELEMETRY_DIR;
	process.env.PI_SKILL_TELEMETRY_DIR = root;
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const renderers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) {
			commands.set(name, command);
		},
		registerEntryRenderer(name: string, renderer: (...args: any[]) => unknown) {
			renderers.set(name, renderer);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const emit = async (name: string, event: unknown, ctx: ExtensionContext) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const ctx = {
		cwd: root,
		model: { provider: "test", id: "model-1" },
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const skill = {
		name: "demo",
		description: "demo",
		filePath: skillPath,
		baseDir: skillDir,
		sourceInfo: {},
		disableModelInvocation: false,
	} as Skill;
	try {
		await skillTelemetryExtension(pi);
		assert.ok(commands.has("skill-stats"));
		await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit("input", { type: "input", text: "/skill:demo", source: "interactive" }, ctx);
		await emit("before_agent_start", {
			type: "before_agent_start",
			prompt: `<skill name="demo" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\nDo the work.\n</skill>`,
			systemPromptOptions: { skills: [skill] },
		}, ctx);
		await emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
		await emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "read",
			input: { path: skillPath },
		}, ctx);
		await emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read",
			input: { path: skillPath },
			content: [{ type: "text", text: "Do the work." }],
			isError: false,
		}, ctx);
		await emit("agent_settled", { type: "agent_settled" }, ctx);

		const events = await readLocalEvents(root);
		const invocations = events.filter((event) => event.event_type === "skill_invocation_detected");
		assert.equal(invocations.length, 2);
		assert.deepEqual(invocations.map((event) => event.trigger_mode).sort(), ["explicit", "model_read"]);
		assert.ok(renderers.has("skill-telemetry-invocation"));
		assert.deepEqual(
			entries.map((entry) => ({
				customType: entry.customType,
				skillName: (entry.data as { skillName: string }).skillName,
				triggerMode: (entry.data as { triggerMode: string }).triggerMode,
			})),
			[
				{
					customType: "skill-telemetry-invocation",
					skillName: "demo",
					triggerMode: "explicit",
				},
				{
					customType: "skill-telemetry-invocation",
					skillName: "demo",
					triggerMode: "model_read",
				},
			],
		);
		const renderer = renderers.get("skill-telemetry-invocation");
		assert.ok(renderer);
		const component = renderer(
			{ data: entries[0]?.data },
			{ expanded: false },
			{
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		) as { render(width: number): string[] };
		assert.deepEqual(component.render(80), ["✦ 使用了 demo 技能"]);
		assert.ok(events.some((event) => event.event_type === "skill_load_completed" && event.load_success));
		const serialized = JSON.stringify(events);
		assert.doesNotMatch(serialized, /Do the work/);
		assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	} finally {
		if (previous === undefined) delete process.env.PI_SKILL_TELEMETRY_DIR;
		else process.env.PI_SKILL_TELEMETRY_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
