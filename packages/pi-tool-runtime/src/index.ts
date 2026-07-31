import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isInteractiveTool,
	isTimeoutResult,
	summarizeRecords,
	type RuntimePhase,
	type RuntimeRecord,
} from "./runtime.ts";

const MAX_RECORDS = 500;
const APPROVAL_END_EVENT = "simplecyon:tool-runtime:approval-end";
const TOOL_GUIDANCE = `# Tool Runtime Budget

- Treat Bash timeout values as seconds. Always use a finite timeout: 30 seconds for ordinary commands, up to 120 seconds for tests or builds, and a longer value only when the user explicitly requested an inherently long operation.
- Search from the narrowest useful directory, use file globs and exclusions, and never start from the filesystem root or the whole home directory.
- Batch independent lookups in one tool round. After an empty search, broaden scope at most once. After a timeout, try at most one cheaper fallback; do not repeat the same call unchanged.
- Prefer one-pass scans over per-file global searches. Stop calling tools when another call is unlikely to materially improve the answer.
- Interactive approval and user-question tools may wait for a human; do not describe that waiting time as command execution.`;

function messageRole(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

export default function toolRuntimeExtension(pi: ExtensionAPI): void {
	const records: RuntimeRecord[] = [];
	const toolStarts = new Map<string, { toolName: string; startedAt: number }>();
	const approvalDurations = new Map<string, number>();
	let modelWait: { phase: RuntimePhase; startedAt: number } | undefined;

	const record = (next: RuntimeRecord) => {
		records.push(next);
		if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
		try {
			pi.appendEntry("tool-runtime-event", next);
		} catch {
			// Loader and unit-test runtimes may intentionally omit persistence.
		}
	};

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${TOOL_GUIDANCE}`,
	}));

	pi.on("message_end", (event) => {
		const role = messageRole(event.message);
		if (role === "user") {
			modelWait = { phase: "model-after-user", startedAt: Date.now() };
		} else if (role === "toolResult") {
			modelWait = { phase: "model-after-tool", startedAt: Date.now() };
		}
	});

	pi.on("message_start", (event) => {
		if (messageRole(event.message) !== "assistant" || !modelWait) return;
		record({
			phase: modelWait.phase,
			durationMs: Math.max(0, Date.now() - modelWait.startedAt),
			recordedAt: new Date().toISOString(),
		});
		modelWait = undefined;
	});

	pi.on("tool_execution_start", (event) => {
		toolStarts.set(event.toolCallId, {
			toolName: event.toolName,
			startedAt: Date.now(),
		});
	});

	pi.events.on(APPROVAL_END_EVENT, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const event = payload as {
			toolCallId?: unknown;
			toolName?: unknown;
			durationMs?: unknown;
		};
		if (
			typeof event.toolCallId !== "string" ||
			typeof event.toolName !== "string" ||
			typeof event.durationMs !== "number" ||
			!Number.isFinite(event.durationMs) ||
			event.durationMs < 0
		) return;
		approvalDurations.set(
			event.toolCallId,
			(approvalDurations.get(event.toolCallId) ?? 0) + event.durationMs,
		);
		record({
			phase: "approval",
			toolName: event.toolName,
			durationMs: event.durationMs,
			recordedAt: new Date().toISOString(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		const started = toolStarts.get(event.toolCallId);
		toolStarts.delete(event.toolCallId);
		if (!started) return;
		const totalMs = Math.max(0, Date.now() - started.startedAt);
		const approvalMs = approvalDurations.get(event.toolCallId) ?? 0;
		approvalDurations.delete(event.toolCallId);
		record({
			phase: "tool",
			toolName: started.toolName,
			durationMs: Math.max(0, totalMs - approvalMs),
			recordedAt: new Date().toISOString(),
			isError: event.isError,
			isInteractive: isInteractiveTool(started.toolName),
			timedOut: isTimeoutResult(event.result),
		});
	});

	pi.registerCommand("runtime", {
		description: "Show model-wait and tool-latency statistics for this session",
		handler: async (_args, ctx) => {
			ctx.ui.notify(summarizeRecords(records), "info");
		},
	});
}
