export type RuntimePhase = "model-after-user" | "model-after-tool" | "approval" | "tool";

export interface RuntimeRecord {
	phase: RuntimePhase;
	durationMs: number;
	recordedAt: string;
	toolName?: string;
	isError?: boolean;
	isInteractive?: boolean;
	timedOut?: boolean;
}

const INTERACTIVE_TOOLS = new Set([
	"AskUserQuestion",
	"ask_user_question",
	"safe_delete",
	"safe_restore",
]);

export function isInteractiveTool(toolName: string): boolean {
	return INTERACTIVE_TOOLS.has(toolName);
}

export function isTimeoutResult(result: unknown): boolean {
	let text = "";
	try {
		text = JSON.stringify(result);
	} catch {
		return false;
	}
	return /timed out|timeout[:\s]/i.test(text);
}

export function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
	return sorted[index] ?? 0;
}

export function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
	return `${(durationMs / 60_000).toFixed(1)}m`;
}

export function summarizeRecords(records: readonly RuntimeRecord[]): string {
	const toolRecords = records.filter((record) => record.phase === "tool");
	const modelAfterUser = records.filter((record) => record.phase === "model-after-user");
	const modelAfterTool = records.filter((record) => record.phase === "model-after-tool");
	const approvals = records.filter((record) => record.phase === "approval");
	const lines = ["Pi runtime · current session"];

	const addSummary = (label: string, selected: readonly RuntimeRecord[]) => {
		if (selected.length === 0) {
			lines.push(`${label}: no samples`);
			return;
		}
		const values = selected.map((record) => record.durationMs);
		lines.push(
			`${label}: n=${values.length}, p50 ${formatDuration(percentile(values, 0.5))}, ` +
				`p95 ${formatDuration(percentile(values, 0.95))}, max ${formatDuration(Math.max(...values))}`,
		);
	};

	addSummary("Model after user", modelAfterUser);
	addSummary("Model after tool", modelAfterTool);

	const interactive = toolRecords.filter((record) => record.isInteractive);
	const executionLike = toolRecords.filter((record) => !record.isInteractive);
	addSummary("Tool execution-like", executionLike);
	addSummary("Interactive waiting", interactive);
	addSummary("Safety approval", approvals);

	if (toolRecords.length > 0 || approvals.length > 0) {
		const errors = toolRecords.filter((record) => record.isError).length;
		const timeouts = toolRecords.filter((record) => record.timedOut).length;
		lines.push(
			`Tool split: ${executionLike.length} execution-like, ${interactive.length} interactive/waiting, ` +
				`${approvals.length} approvals, ${errors} errors, ${timeouts} timeouts`,
		);
	}

	const slowest = [...toolRecords]
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, 5);
	if (slowest.length > 0) {
		lines.push("Slowest tools:");
		for (const record of slowest) {
			const suffix = [
				record.isInteractive ? "interactive" : "",
				record.timedOut ? "timeout" : "",
				record.isError ? "error" : "",
			].filter(Boolean);
			lines.push(
				`- ${record.toolName ?? "unknown"}: ${formatDuration(record.durationMs)}` +
					(suffix.length ? ` (${suffix.join(", ")})` : ""),
			);
		}
	}

	return lines.join("\n");
}
