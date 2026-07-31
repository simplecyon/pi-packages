import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const PATCH_MARKER = Symbol.for("@simplecyon/pi-minimal-tui/suppress-thinking-labels");
const ANSI_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`;
const ANSI_PATTERN = new RegExp(ANSI_SOURCE, "g");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OSC133_ZONE_END_FINAL = OSC133_ZONE_END + OSC133_ZONE_FINAL;

/**
 * Narrow view of Pi's `AssistantMessage` — only the field this patch reads.
 * Declared locally so the package does not need to depend on `@earendil-works/pi-ai`.
 */
interface AssistantMessageLike {
	stopReason?: string;
}

interface PatchableAssistantMessage {
	render(width: number): string[];
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	lastMessage?: AssistantMessageLike;
	[PATCH_MARKER]?: boolean;
}

function plainText(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

function visuallyEmpty(line: string): boolean {
	return plainText(line).trim().length === 0;
}

function isThinkingLabelLine(line: string, label: string): boolean {
	if (!label) return false;
	return plainText(line).trim() === label;
}

function trimEmptyEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && visuallyEmpty(lines[start] ?? "")) start += 1;
	while (end > start && visuallyEmpty(lines[end - 1] ?? "")) end -= 1;
	return lines.slice(start, end);
}

function collapseBlankRuns(lines: string[]): string[] {
	const out: string[] = [];
	let prevBlank = false;
	for (const line of lines) {
		const blank = visuallyEmpty(line);
		if (blank && prevBlank) continue;
		out.push(line);
		prevBlank = blank;
	}
	return out;
}

/**
 * Remove Pi's hidden-thinking placeholder rows (the static "Thinking..."
 * label, one per thinking run) from already-rendered assistant-message lines.
 *
 * Pi emits one label per thinking run; with `hideThinkingBlock` on and
 * several thinking/tool interleavings in a single turn, that stacks into N
 * identical rows. Once the turn finishes, minimal-tui renders its own
 * `• Thought for …` line, making the per-run labels redundant. This collapses
 * them away and migrates the OSC 133 zone markers that Pi wraps around the
 * first/last line onto the surviving edges, so terminal prompt tracking stays
 * intact.
 */
export function stripThinkingLabelLines(lines: readonly string[], label: string): string[] {
	if (!label) return [...lines];
	const hadZoneStart = lines[0]?.startsWith(OSC133_ZONE_START) ?? false;
	const last = lines[lines.length - 1];
	const hadZoneEndFinal = last?.startsWith(OSC133_ZONE_END_FINAL) ?? false;

	const filtered = lines.filter((line) => !isThinkingLabelLine(line, label));
	if (filtered.length === lines.length) return [...lines];

	const result = collapseBlankRuns(trimEmptyEdges(filtered));
	if (result.length === 0) return result;

	if (hadZoneStart && !result[0].startsWith(OSC133_ZONE_START)) {
		result[0] = OSC133_ZONE_START + result[0];
	}
	if (hadZoneEndFinal && !result[result.length - 1].startsWith(OSC133_ZONE_END_FINAL)) {
		result[result.length - 1] = OSC133_ZONE_END_FINAL + result[result.length - 1];
	}
	return result;
}

/**
 * Monkey-patch `AssistantMessageComponent.prototype.render` (same pattern as
 * `installCompactUserMessageRendering`) so that, once a turn is complete and
 * `hideThinkingBlock` is on, the redundant per-run "Thinking..." labels are
 * stripped while minimal-tui's `• Thought for …` takes over. Idempotent via a
 * `Symbol.for` marker.
 */
export function installThinkingSuppression(): void {
	const proto = AssistantMessageComponent.prototype as unknown as PatchableAssistantMessage;
	if (proto[PATCH_MARKER]) return;

	const originalRender = proto.render;
	proto.render = function renderSuppressThinking(this: PatchableAssistantMessage, width: number): string[] {
		const lines = originalRender.call(this, width);
		// Only engage when Pi is hiding thinking blocks behind the static label.
		if (!this.hideThinkingBlock) return lines;
		const message = this.lastMessage;
		// Keep Pi's native live "Thinking..." label while the run is streaming
		// (stopReason unset) so the user still sees a thinking indicator; only
		// collapse once the turn is complete, at which point minimal-tui renders
		// its own "• Thought for …".
		if (!message || !message.stopReason) return lines;
		return stripThinkingLabelLines(lines, this.hiddenThinkingLabel);
	};
	proto[PATCH_MARKER] = true;
}
