import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	estimateTextTokens,
	parseArtifactizedResultEvent,
	parseVerifiedMilestoneEvent,
	TOKEN_ROI_ARTIFACT_EVENT,
	TOKEN_ROI_MILESTONE_EVENT,
	TokenRoiTracker,
	type TokenRoiSnapshot,
} from "@simplecyon/pi-context-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

interface ReportSnapshot extends TokenRoiSnapshot {
	generatedAt: string;
	sessionId?: string;
	context: {
		tokens: number | null;
		contextWindow: number | null;
		percent: number | null;
	};
	activeTools: {
		count: number;
		schemaTokens: number;
	};
	economics: {
		economicTokensPerMilestone: number | null;
		modelRequestsPerMilestone: number | null;
	};
	advice: RoiAdvice[];
}

interface RoiAdvice {
	code: string;
	priority: "info" | "warning";
	message: string;
}

function estimateActiveToolSchemas(pi: ExtensionAPI): { count: number; schemaTokens: number } {
	try {
		const activeNames = new Set(pi.getActiveTools());
		const tools = pi.getAllTools().filter((tool) => activeNames.has(tool.name));
		return {
			count: tools.length,
			schemaTokens: tools.reduce((sum, tool) => sum + estimateToolSchema(tool), 0),
		};
	} catch {
		return { count: 0, schemaTokens: 0 };
	}
}

function estimateToolSchema(tool: {
	name: string;
	description: string;
	parameters: unknown;
}): number {
	return estimateTextTokens(tool.name) +
		estimateTextTokens(tool.description) +
		estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
}

function buildReport(
	tracker: TokenRoiTracker,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): ReportSnapshot {
	const context = ctx.getContextUsage();
	const snapshot = tracker.snapshot();
	const activeTools = estimateActiveToolSchemas(pi);
	const report: ReportSnapshot = {
		...snapshot,
		generatedAt: new Date().toISOString(),
		sessionId: ctx.sessionManager.getSessionId(),
		context: {
			tokens: context?.tokens ?? null,
			contextWindow: context?.contextWindow ?? null,
			percent: context?.percent ?? null,
		},
		activeTools,
		economics: {
			economicTokensPerMilestone: snapshot.verifiedMilestones > 0
				? snapshot.usage.totalTokens / snapshot.verifiedMilestones
				: null,
			modelRequestsPerMilestone: snapshot.verifiedMilestones > 0
				? snapshot.assistantRequests / snapshot.verifiedMilestones
				: null,
		},
		advice: [],
	};
	report.advice = buildAdvice(report);
	return report;
}

function buildAdvice(report: Omit<ReportSnapshot, "advice"> & { advice?: RoiAdvice[] }): RoiAdvice[] {
	const advice: RoiAdvice[] = [];
	if (report.operationPatterns.readWriteDeleteCandidates > 0) {
		advice.push({
			code: "relocation_candidate",
			priority: "warning",
			message: `${report.operationPatterns.readWriteDeleteCandidates} read→write→delete candidate(s) observed; when the intent is pure relocation, prefer one move operation plus bounded verification.`,
		});
	}
	if (
		report.duplicateResultTokens >= 256 &&
		report.duplicateResultTokens / Math.max(1, report.toolResultTokens) >= 0.1
	) {
		advice.push({
			code: "duplicate_results",
			priority: "warning",
			message: `${formatTokens(report.duplicateResultTokens)} estimated duplicate result tokens observed; reuse earlier evidence or a compact artifact reference.`,
		});
	}
	if (
		report.toolYields >= 3 &&
		report.usage.cacheRead / report.toolYields >= 5000 &&
		report.toolCalls / report.toolYields < 1.5
	) {
		advice.push({
			code: "continuation_overhead",
			priority: "warning",
			message: "Tool yields are repeating a large cached prefix; batch independent reads and prefer compound operations with one verification boundary.",
		});
	}
	const schemaShare = report.context.contextWindow
		? report.activeTools.schemaTokens / report.context.contextWindow
		: 0;
	if (report.activeTools.schemaTokens >= 2000 && schemaShare >= 0.05) {
		advice.push({
			code: "schema_overhead",
			priority: "info",
			message: `${formatTokens(report.activeTools.schemaTokens)} estimated schema tokens are active; consider dynamically loading specialist tools.`,
		});
	}
	if (report.verifiedMilestones === 0 && report.assistantRequests >= 3) {
		advice.push({
			code: "missing_milestones",
			priority: "info",
			message: "No verified milestones were emitted, so end-to-end ROI has no progress denominator yet.",
		});
	}
	return advice;
}

function formatTokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatReport(report: ReportSnapshot): string {
	const context = report.context.tokens == null
		? "unknown"
		: `${formatTokens(report.context.tokens)} / ${formatTokens(report.context.contextWindow ?? 0)}`;
	const cost = report.usage.cost.total > 0 ? ` · cost $${report.usage.cost.total.toFixed(4)}` : "";
	return [
		`ROI window: ${report.assistantRequests} model requests · ${report.toolCalls} tool calls · ${report.toolYields} tool yields`,
		`Usage: input ${formatTokens(report.usage.input)} · cache read ${formatTokens(report.usage.cacheRead)} · output ${formatTokens(report.usage.output)}${cost}`,
		`Tool results: ${report.toolResults} results / ${formatTokens(report.toolResultTokens)} est. tokens · ${report.duplicateResults} duplicates (${formatTokens(report.duplicateResultTokens)} tokens) · ${report.toolErrors} errors`,
		`Artifacts: ${report.artifactizedResults} results · ${report.artifactReuses} duplicate reuses · ${formatTokens(report.artifactTokensSaved)} estimated context tokens removed`,
		`Verified progress: ${report.verifiedMilestones} milestones · ${report.economics.economicTokensPerMilestone == null ? "ROI denominator unavailable" : `${formatTokens(report.economics.economicTokensPerMilestone)} economic tokens / milestone`}`,
		`Current context: ${context} · active schemas ${report.activeTools.count} tools / ${formatTokens(report.activeTools.schemaTokens)} est. tokens`,
		...report.advice.slice(0, 3).map((item) => `Advice: ${item.message}`),
	].join("\n");
}

function parseExportPath(args: string, cwd: string): string | undefined {
	const trimmed = args.trim();
	const match = /^--json(?:\s+(.*))?$/.exec(trimmed);
	if (!match) return undefined;
	const candidate = match[1]?.trim() ?? "";
	const path = candidate || ".pi/roi/roi-latest.json";
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export default function tokenRoiExtension(pi: ExtensionAPI): void {
	const tracker = new TokenRoiTracker();

	pi.events.on(TOKEN_ROI_MILESTONE_EVENT, (data) => {
		const milestone = parseVerifiedMilestoneEvent(data);
		if (milestone) tracker.recordVerifiedMilestone(milestone);
	});
	pi.events.on(TOKEN_ROI_ARTIFACT_EVENT, (data) => {
		const artifact = parseArtifactizedResultEvent(data);
		if (artifact) tracker.recordArtifactizedResult(artifact);
	});

	pi.registerCommand("roi", {
		description: "Show Token ROI telemetry; use --json [path] to export",
		handler: async (args, ctx) => {
			const report = buildReport(tracker, pi, ctx);
			const exportPath = parseExportPath(args, ctx.cwd);
			if (exportPath) {
				await mkdir(dirname(exportPath), { recursive: true });
				await writeFile(exportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
				ctx.ui.notify(`Token ROI report written to ${exportPath}`, "info");
				return;
			}
			if (args.trim().length > 0) {
				ctx.ui.notify("Usage: /roi or /roi --json [path]", "warning");
				return;
			}
			ctx.ui.notify(formatReport(report), "info");
		},
	});

	pi.on("session_start", async () => {
		tracker.reset();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			tracker.recordAssistantUsage(event.message.usage);
		}
	});

	pi.on("tool_call", async (event) => {
		tracker.recordToolCall(event.toolName, event.input);
	});

	pi.on("tool_result", async (event) => {
		tracker.recordToolResult(event.content, event.isError);
	});

	pi.on("turn_end", async (event) => {
		tracker.recordToolYield(event.toolResults.length);
	});
}

export { buildAdvice, buildReport, formatReport, parseExportPath };
