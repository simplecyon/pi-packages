import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const ANSI_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`;
const ANSI_PATTERN = new RegExp(ANSI_SOURCE, "g");
const LEFT_PADDING_PATTERN = new RegExp(`^((?:${ANSI_SOURCE})*) ((?:${ANSI_SOURCE})*)`);
const PATCH_MARKER = Symbol.for("@simplecyon/pi-minimal-tui/compact-user-message");
const DIM_ARROW = "\x1b[2m>\x1b[22m ";
const MEDIUM_TEXT_START = "\x1b[1m";
const MEDIUM_TEXT_END = "\x1b[22m";

interface PatchableUserMessagePrototype {
	render(width: number): string[];
	[PATCH_MARKER]?: boolean;
}

function visuallyBlank(line: string): boolean {
	return line.replace(ANSI_PATTERN, "").trim().length === 0;
}

function compactTopPadding(lines: string[]): string[] {
	const compacted = [...lines];
	const first = compacted[0];
	if (first?.startsWith(OSC133_ZONE_START)) {
		const withoutZone = first.slice(OSC133_ZONE_START.length);
		if (compacted.length > 1 && visuallyBlank(withoutZone)) {
			compacted.shift();
			if (compacted[0] !== undefined) compacted[0] = OSC133_ZONE_START + compacted[0];
		}
	}

	return compacted;
}

function styleUserMessageLine(line: string): string {
	if (visuallyBlank(line)) return line;

	const styled = line.replace(
		LEFT_PADDING_PATTERN,
		(_match, controlsBefore: string, controlsAfter: string) =>
			`${controlsBefore}${DIM_ARROW}${controlsAfter}${MEDIUM_TEXT_START}`,
	);
	return styled === line ? line : `${styled}${MEDIUM_TEXT_END}`;
}

export function installCompactUserMessageRendering(): void {
	const prototype = UserMessageComponent.prototype as PatchableUserMessagePrototype;
	if (prototype[PATCH_MARKER]) return;

	const originalRender = prototype.render;
	prototype.render = function renderCompactUserMessage(width: number): string[] {
		const lines = compactTopPadding(originalRender.call(this, Math.max(1, width - 1)));
		return lines.map(styleUserMessageLine);
	};
	prototype[PATCH_MARKER] = true;
}
