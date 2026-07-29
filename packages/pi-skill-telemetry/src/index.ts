import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	isToolCallEventType,
	parseSkillBlock,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { readLocalEvents, TelemetryWriter } from "./storage.ts";
import { summarizeEvents } from "./summary.ts";

interface ExplicitPending {
	invocationId: string;
	skillName: string;
	startedAt: number;
}

interface ToolPending {
	invocationId: string;
	skill: Skill;
	startedAt: number;
}

interface SkillInvocationEntry {
	skillName: string;
	triggerMode: "explicit" | "model_read";
	recordedAt: string;
}

const SKILL_INVOCATION_ENTRY = "skill-telemetry-invocation";

function skillId(skillName: string): string {
	return `skill:${skillName}`;
}

async function skillVersion(skill: Skill | undefined): Promise<string | undefined> {
	if (!skill) return undefined;
	try {
		const content = await readFile(skill.filePath);
		return `sha256:${createHash("sha256").update(content).digest("hex")}`;
	} catch {
		return undefined;
	}
}

function modelFields(ctx: ExtensionContext): { provider?: string; model?: string } {
	const model = (ctx as ExtensionContext & {
		model?: { provider?: string; id?: string; name?: string };
	}).model;
	return {
		provider: model?.provider,
		model: model?.id ?? model?.name,
	};
}

export default async function skillTelemetryExtension(pi: ExtensionAPI): Promise<void> {
	const writer = await TelemetryWriter.create();
	let globalSessionId: string | undefined;
	let sessionInstanceId = randomUUID();
	let turnIndex = 0;
	let lastCatalogHash = "";
	let skillsByName = new Map<string, Skill>();
	let skillsByPath = new Map<string, Skill>();
	const explicitPending: ExplicitPending[] = [];
	const toolPending = new Map<string, ToolPending>();
	const activeSkillIds = new Set<string>();

	pi.registerEntryRenderer<SkillInvocationEntry>(
		SKILL_INVOCATION_ENTRY,
		(entry, { expanded }, theme) => {
			const data = entry.data;
			const skillName = data?.skillName ?? "unknown";
			const mode = data?.triggerMode === "model_read" ? "模型读取" : "显式调用";
			const line = [
				theme.fg("accent", "✦"),
				theme.fg("muted", "使用了"),
				theme.fg("accent", theme.bold(skillName)),
				theme.fg("muted", "技能"),
			].join(" ");
			const text = expanded && data
				? `${line}\n${theme.fg("dim", `${mode} · ${data.recordedAt}`)}`
				: line;
			return {
				render: () => text.split("\n"),
				invalidate: () => {},
			};
		},
	);

	const renderSkillInvocation = (
		skillName: string,
		triggerMode: SkillInvocationEntry["triggerMode"],
	) => {
		pi.appendEntry<SkillInvocationEntry>(SKILL_INVOCATION_ENTRY, {
			skillName,
			triggerMode,
			recordedAt: new Date().toISOString(),
		});
	};

	const sessionFields = () => ({
		global_session_id: globalSessionId,
		session_instance_id: sessionInstanceId,
		turn_index: turnIndex,
	});

	pi.registerCommand("skill-stats", {
		description: "Show local Pi skill usage captured on this device",
		handler: async (_args, ctx) => {
			await writer.flush();
			const rows = summarizeEvents(await readLocalEvents(writer.root));
			if (rows.length === 0) {
				ctx.ui.notify("No skill telemetry captured yet", "info");
				return;
			}
			const total = rows.reduce((sum, row) => sum + row.invocations, 0);
			const top = rows.slice(0, 5).map((row) => `${row.skill_name} ${row.invocations}`).join(" · ");
			ctx.ui.notify(`${total} invocation${total === 1 ? "" : "s"} · ${top}`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		globalSessionId = ctx.sessionManager.getSessionId();
		sessionInstanceId = randomUUID();
		turnIndex = 0;
		lastCatalogHash = "";
		skillsByName.clear();
		skillsByPath.clear();
		explicitPending.length = 0;
		toolPending.clear();
		activeSkillIds.clear();
		await writer.record({
			event_type: "session_started",
			...sessionFields(),
			reason: event.reason,
			...modelFields(ctx),
		});
	});

	pi.on("turn_start", async (event) => {
		turnIndex = event.turnIndex;
	});

	pi.on("input", async (event) => {
		const match = /^\/skill:([^\s]+)/.exec(event.text.trim());
		if (!match) return { action: "continue" as const };
		const invocationId = randomUUID();
		const skillName = match[1];
		explicitPending.push({ invocationId, skillName, startedAt: Date.now() });
		activeSkillIds.add(skillId(skillName));
		await writer.record({
			event_type: "skill_invocation_detected",
			...sessionFields(),
			skill_id: skillId(skillName),
			skill_name: skillName,
			trigger_mode: "explicit",
			confidence: "high",
			invocation_id: invocationId,
		});
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills ?? [];
		skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
		skillsByPath = new Map(skills.map((skill) => [resolve(skill.filePath), skill]));
		const catalog = [...skillsByName.keys()].sort();
		const catalogHash = createHash("sha256").update(catalog.join("\n")).digest("hex");
		if (catalogHash !== lastCatalogHash) {
			lastCatalogHash = catalogHash;
			await writer.record({
				event_type: "skill_catalog_snapshot",
				...sessionFields(),
				skill_ids: catalog.map(skillId),
				...modelFields(ctx),
			});
		}

		const block = parseSkillBlock(event.prompt);
		if (block) {
			const pendingIndex = explicitPending.findIndex((item) => item.skillName === block.name);
			const pending = pendingIndex >= 0
				? explicitPending.splice(pendingIndex, 1)[0]
				: undefined;
			const invocationId = pending?.invocationId ?? randomUUID();
			if (!pending) {
				activeSkillIds.add(skillId(block.name));
				await writer.record({
					event_type: "skill_invocation_detected",
					...sessionFields(),
					skill_id: skillId(block.name),
					skill_name: block.name,
					trigger_mode: "explicit",
					confidence: "high",
					invocation_id: invocationId,
				});
			}
			renderSkillInvocation(block.name, "explicit");
			await writer.record({
				event_type: "skill_load_completed",
				...sessionFields(),
				skill_id: skillId(block.name),
				skill_name: block.name,
				skill_version: await skillVersion(skillsByName.get(block.name)),
				trigger_mode: "explicit",
				confidence: "high",
				invocation_id: invocationId,
				load_success: true,
				duration_ms: pending ? Math.max(0, Date.now() - pending.startedAt) : 0,
				...modelFields(ctx),
			});
		} else if (explicitPending.length > 0) {
			const pending = explicitPending.shift();
			if (pending) {
				await writer.record({
					event_type: "skill_load_completed",
					...sessionFields(),
					skill_id: skillId(pending.skillName),
					skill_name: pending.skillName,
					trigger_mode: "explicit",
					confidence: "high",
					invocation_id: pending.invocationId,
					load_success: false,
					duration_ms: Math.max(0, Date.now() - pending.startedAt),
					reason: "skill command was not expanded",
					...modelFields(ctx),
				});
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;
		const path = resolve(ctx.cwd, event.input.path);
		const skill = skillsByPath.get(path);
		if (!skill) return;
		const invocationId = randomUUID();
		toolPending.set(event.toolCallId, { invocationId, skill, startedAt: Date.now() });
		activeSkillIds.add(skillId(skill.name));
		renderSkillInvocation(skill.name, "model_read");
		const common = {
			...sessionFields(),
			skill_id: skillId(skill.name),
			skill_name: skill.name,
			skill_version: await skillVersion(skill),
			trigger_mode: "model_read" as const,
			confidence: "high" as const,
			invocation_id: invocationId,
			tool_call_id: event.toolCallId,
			...modelFields(ctx),
		};
		await writer.record({ event_type: "skill_invocation_detected", ...common });
		await writer.record({ event_type: "skill_load_started", ...common });
	});

	pi.on("tool_result", async (event, ctx) => {
		const pending = toolPending.get(event.toolCallId);
		if (!pending) return;
		toolPending.delete(event.toolCallId);
		await writer.record({
			event_type: "skill_load_completed",
			...sessionFields(),
			skill_id: skillId(pending.skill.name),
			skill_name: pending.skill.name,
			skill_version: await skillVersion(pending.skill),
			trigger_mode: "model_read",
			confidence: "high",
			invocation_id: pending.invocationId,
			tool_call_id: event.toolCallId,
			load_success: !event.isError,
			duration_ms: Math.max(0, Date.now() - pending.startedAt),
			...modelFields(ctx),
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (activeSkillIds.size === 0) return;
		await writer.record({
			event_type: "agent_settled",
			...sessionFields(),
			skill_ids: [...activeSkillIds].sort(),
			...modelFields(ctx),
		});
		activeSkillIds.clear();
		await writer.seal();
	});

	pi.on("session_shutdown", async (event) => {
		await writer.record({
			event_type: "session_shutdown",
			...sessionFields(),
			reason: event.reason,
		});
		await writer.seal();
	});
}
