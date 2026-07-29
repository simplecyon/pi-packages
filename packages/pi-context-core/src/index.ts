import { createHash } from "node:crypto";

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface ContentBlockLike {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export const TOKEN_ROI_MILESTONE_EVENT = "token-roi:verified-milestone";
export const TOKEN_ROI_ARTIFACT_EVENT = "token-roi:artifactized-result";

export interface VerifiedMilestoneEvent {
	/**
	 * Stable low-cardinality taxonomy key, for example "task_completed".
	 * Do not put paths, prompts, customer names, or other user data here.
	 */
	kind: string;
	count?: number;
}

export interface ArtifactizedResultEvent {
	originalTokens: number;
	visibleTokens: number;
	reused?: boolean;
}

export interface OperationPatternSnapshot {
	readWriteDeleteCandidates: number;
	directMoves: number;
}

export interface TokenRoiSnapshot {
	startedAt: string;
	assistantRequests: number;
	toolCalls: number;
	toolYields: number;
	toolResults: number;
	toolErrors: number;
	toolResultTokens: number;
	duplicateResults: number;
	duplicateResultTokens: number;
	verifiedMilestones: number;
	milestonesByKind: Record<string, number>;
	operationPatterns: OperationPatternSnapshot;
	artifactizedResults: number;
	artifactReuses: number;
	artifactSourceTokens: number;
	artifactTokensVisible: number;
	artifactTokensSaved: number;
	usage: UsageTotals;
}

const CJK_CHARS_PER_TOKEN = 1.5;
const IMAGE_TOKENS = 1200;

function isCjk(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x11ff) ||
		(codePoint >= 0x2e80 && codePoint <= 0x303f) ||
		(codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xff00 && codePoint <= 0xffef) ||
		(codePoint >= 0x20000 && codePoint <= 0x2fa1f)
	);
}

export function estimateTextTokens(text: string | undefined | null): number {
	if (!text) return 0;
	let cjk = 0;
	let total = 0;
	for (const character of text) {
		total++;
		if (isCjk(character.codePointAt(0) ?? 0)) cjk++;
	}
	return Math.ceil((total - cjk) / 4 + cjk / CJK_CHARS_PER_TOKEN);
}

export function emptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(target: UsageTotals, usage: UsageLike): void {
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.totalTokens += usage.totalTokens ??
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	target.cost.input += usage.cost?.input ?? 0;
	target.cost.output += usage.cost?.output ?? 0;
	target.cost.cacheRead += usage.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
	target.cost.total += usage.cost?.total ?? 0;
}

export function contentText(content: readonly ContentBlockLike[]): string {
	return content
		.map((block) => block.type === "text" ? block.text ?? "" : `[${block.mimeType ?? block.type ?? "binary"}]`)
		.join("\n");
}

export function estimateContentTokens(content: readonly ContentBlockLike[]): number {
	return content.reduce(
		(sum, block) => sum + (block.type === "image" ? IMAGE_TOKENS : estimateTextTokens(block.text)),
		0,
	);
}

export function fingerprintContent(content: readonly ContentBlockLike[]): string {
	const hash = createHash("sha256");
	for (const block of content) {
		hash.update(block.type ?? "");
		hash.update("\0");
		hash.update(block.mimeType ?? "");
		hash.update("\0");
		hash.update(block.text ?? "");
		hash.update("\0");
		hash.update(block.data ?? "");
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function parseVerifiedMilestoneEvent(value: unknown): VerifiedMilestoneEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { kind?: unknown; count?: unknown };
	if (
		typeof candidate.kind !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.kind)
	) {
		return undefined;
	}
	const count = candidate.count ?? 1;
	if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 100) {
		return undefined;
	}
	return { kind: candidate.kind, count: count as number };
}

export function parseArtifactizedResultEvent(value: unknown): ArtifactizedResultEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ArtifactizedResultEvent>;
	if (
		!Number.isSafeInteger(candidate.originalTokens) ||
		!Number.isSafeInteger(candidate.visibleTokens) ||
		(candidate.originalTokens ?? -1) < 1 ||
		(candidate.visibleTokens ?? -1) < 0 ||
		(candidate.visibleTokens ?? 0) >= (candidate.originalTokens ?? 0) ||
		(candidate.reused !== undefined && typeof candidate.reused !== "boolean")
	) {
		return undefined;
	}
	return {
		originalTokens: candidate.originalTokens as number,
		visibleTokens: candidate.visibleTokens as number,
		reused: candidate.reused === true,
	};
}

function classifyOperation(toolName: string | undefined, input: unknown): "read" | "write" | "delete" | "move" | "other" {
	if (toolName === "read") return "read";
	if (toolName === "write") return "write";
	if (toolName !== "bash" || !input || typeof input !== "object") return "other";
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return "other";
	if (/(?:^|[;&|]\s*|\s)mv(?:\s|$)/.test(command)) return "move";
	if (/(?:^|[;&|]\s*|\s)(?:rm|unlink)(?:\s|$)/.test(command)) return "delete";
	return "other";
}

export class OperationPatternTracker {
	private recent: Array<"read" | "write" | "delete" | "move" | "other"> = [];
	private readWriteDeleteCandidates = 0;
	private directMoves = 0;

	reset(): void {
		this.recent = [];
		this.readWriteDeleteCandidates = 0;
		this.directMoves = 0;
	}

	recordToolCall(toolName?: string, input?: unknown): void {
		const operation = classifyOperation(toolName, input);
		if (operation === "move") this.directMoves++;
		this.recent.push(operation);
		if (this.recent.length > 3) this.recent.shift();
		if (
			this.recent.length === 3 &&
			this.recent[0] === "read" &&
			this.recent[1] === "write" &&
			this.recent[2] === "delete"
		) {
			this.readWriteDeleteCandidates++;
			this.recent = [];
		}
	}

	snapshot(): OperationPatternSnapshot {
		return {
			readWriteDeleteCandidates: this.readWriteDeleteCandidates,
			directMoves: this.directMoves,
		};
	}
}

export class TokenRoiTracker {
	private startedAt = new Date();
	private assistantRequests = 0;
	private toolCalls = 0;
	private toolYields = 0;
	private toolResults = 0;
	private toolErrors = 0;
	private toolResultTokens = 0;
	private duplicateResults = 0;
	private duplicateResultTokens = 0;
	private verifiedMilestones = 0;
	private milestonesByKind = new Map<string, number>();
	private artifactizedResults = 0;
	private artifactReuses = 0;
	private artifactSourceTokens = 0;
	private artifactTokensVisible = 0;
	private usage = emptyUsageTotals();
	private fingerprints = new Set<string>();
	private operationPatterns = new OperationPatternTracker();

	reset(now = new Date()): void {
		this.startedAt = now;
		this.assistantRequests = 0;
		this.toolCalls = 0;
		this.toolYields = 0;
		this.toolResults = 0;
		this.toolErrors = 0;
		this.toolResultTokens = 0;
		this.duplicateResults = 0;
		this.duplicateResultTokens = 0;
		this.verifiedMilestones = 0;
		this.milestonesByKind.clear();
		this.artifactizedResults = 0;
		this.artifactReuses = 0;
		this.artifactSourceTokens = 0;
		this.artifactTokensVisible = 0;
		this.usage = emptyUsageTotals();
		this.fingerprints.clear();
		this.operationPatterns.reset();
	}

	recordAssistantUsage(usage: UsageLike): void {
		this.assistantRequests++;
		addUsage(this.usage, usage);
	}

	recordToolCall(toolName?: string, input?: unknown): void {
		this.toolCalls++;
		this.operationPatterns.recordToolCall(toolName, input);
	}

	recordToolYield(toolResultCount: number): void {
		if (toolResultCount > 0) this.toolYields++;
	}

	recordToolResult(content: readonly ContentBlockLike[], isError: boolean): void {
		this.toolResults++;
		if (isError) this.toolErrors++;
		const text = contentText(content);
		const tokens = estimateContentTokens(content);
		this.toolResultTokens += tokens;
		if (text.length === 0) return;
		const fingerprint = fingerprintContent(content);
		if (this.fingerprints.has(fingerprint)) {
			this.duplicateResults++;
			this.duplicateResultTokens += tokens;
		} else {
			this.fingerprints.add(fingerprint);
		}
	}

	recordVerifiedMilestone(event: VerifiedMilestoneEvent): void {
		const count = event.count ?? 1;
		this.verifiedMilestones += count;
		this.milestonesByKind.set(event.kind, (this.milestonesByKind.get(event.kind) ?? 0) + count);
	}

	recordArtifactizedResult(event: ArtifactizedResultEvent): void {
		this.artifactizedResults++;
		if (event.reused) this.artifactReuses++;
		this.artifactSourceTokens += event.originalTokens;
		this.artifactTokensVisible += event.visibleTokens;
	}

	snapshot(): TokenRoiSnapshot {
		return {
			startedAt: this.startedAt.toISOString(),
			assistantRequests: this.assistantRequests,
			toolCalls: this.toolCalls,
			toolYields: this.toolYields,
			toolResults: this.toolResults,
			toolErrors: this.toolErrors,
			toolResultTokens: this.toolResultTokens,
			duplicateResults: this.duplicateResults,
			duplicateResultTokens: this.duplicateResultTokens,
			verifiedMilestones: this.verifiedMilestones,
			milestonesByKind: Object.fromEntries(
				[...this.milestonesByKind.entries()].sort(([left], [right]) => left.localeCompare(right)),
			),
			operationPatterns: this.operationPatterns.snapshot(),
			artifactizedResults: this.artifactizedResults,
			artifactReuses: this.artifactReuses,
			artifactSourceTokens: this.artifactSourceTokens,
			artifactTokensVisible: this.artifactTokensVisible,
			artifactTokensSaved: this.artifactSourceTokens - this.artifactTokensVisible,
			usage: {
				...this.usage,
				cost: { ...this.usage.cost },
			},
		};
	}
}
