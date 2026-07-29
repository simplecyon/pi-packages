import { estimateContentTokens, estimateTextTokens } from "@simplecyon/pi-context-core";
import type {
	ArtifactDecision,
	ArtifactPolicy,
	TextBlock,
} from "./types.ts";

const INTERNAL_TOOLS = new Set(["artifact_read", "compact_search"]);

function integerEnv(name: string, fallback: number, minimum: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadPolicy(): ArtifactPolicy {
	const hardTokens = integerEnv("PI_CONTEXT_ARTIFACTS_HARD_TOKENS", 24_000, 4_000);
	const pressureTokens = integerEnv("PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS", 8_000, 2_000);
	const requestedVisible = integerEnv("PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS", 3_000, 500);
	return {
		hardTokens,
		pressureTokens,
		pressurePercent: Math.min(
			100,
			integerEnv("PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT", 65, 1),
		),
		visibleTokens: Math.min(
			requestedVisible,
			Math.floor(Math.min(hardTokens, pressureTokens) / 2),
		),
		readChunkCharacters: 12_000,
	};
}

export function decideArtifact(
	toolName: string,
	content: readonly ({ type: string; text?: string })[],
	isError: boolean,
	contextPercent: number | null | undefined,
	policy: ArtifactPolicy,
	safetyReady: boolean,
): ArtifactDecision {
	const originalTokens = estimateContentTokens(content);
	if (!safetyReady) return { archive: false, reason: "safety-unavailable", originalTokens };
	if (isError) return { archive: false, reason: "error-result", originalTokens };
	if (INTERNAL_TOOLS.has(toolName)) return { archive: false, reason: "recovery-tool", originalTokens };
	if (content.length === 0 || content.some((block) => block.type !== "text")) {
		return { archive: false, reason: "non-text-result", originalTokens };
	}
	if (originalTokens >= policy.hardTokens) {
		return { archive: true, reason: "hard-threshold", originalTokens };
	}
	if (
		(contextPercent ?? 0) >= policy.pressurePercent &&
		originalTokens >= policy.pressureTokens
	) {
		return { archive: true, reason: "context-pressure", originalTokens };
	}
	return { archive: false, reason: "below-threshold", originalTokens };
}

function takeHead(text: string, tokenBudget: number): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (estimateTextTokens(text.slice(0, mid)) <= tokenBudget) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}

function takeTail(text: string, tokenBudget: number): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const length = Math.ceil((low + high) / 2);
		if (estimateTextTokens(text.slice(text.length - length)) <= tokenBudget) low = length;
		else high = length - 1;
	}
	return text.slice(text.length - low);
}

export function buildArtifactPreview(
	content: readonly TextBlock[],
	id: string,
	originalTokens: number,
	policy: ArtifactPolicy,
): string {
	const text = content.map((block) => block.text).join("\n");
	const header =
		`[Large tool result archived as ${id}: ${originalTokens} estimated tokens. ` +
		`Use artifact_read with this id for exact bounded recovery.]\n\n`;
	const footer = `\n\n[… ${Math.max(0, text.length)} source characters total · artifact ${id} …]`;
	const framingTokens = estimateTextTokens(header) + estimateTextTokens(footer);
	const bodyBudget = Math.max(100, policy.visibleTokens - framingTokens);
	const headBudget = Math.floor(bodyBudget * 0.7);
	const tailBudget = bodyBudget - headBudget;
	const head = takeHead(text, headBudget);
	const tail = takeTail(text, tailBudget);
	const omitted = Math.max(0, text.length - head.length - tail.length);
	return `${header}${head}\n\n[… ${omitted} characters omitted …]\n\n${tail}${footer}`;
}
