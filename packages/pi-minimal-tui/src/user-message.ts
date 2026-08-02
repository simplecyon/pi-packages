import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

const ANSI_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`;
const ANSI_PATTERN = new RegExp(ANSI_SOURCE, "g");
const LEFT_PADDING_PATTERN = new RegExp(`^((?:${ANSI_SOURCE})*) ((?:${ANSI_SOURCE})*)`);
const CORE_RENDER = Symbol.for("@simplecyon/pi-minimal-tui/core-render");
const DIM_ARROW = "\x1b[2m>\x1b[22m ";
const MEDIUM_TEXT_START = "\x1b[1m";
const MEDIUM_TEXT_END = "\x1b[22m";

interface PatchableUserMessagePrototype {
	render(width: number): string[];
	[CORE_RENDER]?: (width: number) => string[];
}

function visuallyBlank(line: string): boolean {
	return line.replace(ANSI_PATTERN, "").trim().length === 0;
}

function styleUserMessageLine(line: string): string {
	const styled = line.replace(
		LEFT_PADDING_PATTERN,
		(_match, controlsBefore: string, controlsAfter: string) =>
			`${controlsBefore}${DIM_ARROW}${controlsAfter}${MEDIUM_TEXT_START}`,
	);
	return styled === line ? line : `${styled}${MEDIUM_TEXT_END}`;
}

export function installCompactUserMessageRendering(): void {
	const prototype = UserMessageComponent.prototype as PatchableUserMessagePrototype;
	// 保存 pi core 原版 render(进程级持久)，extension 热加载重跑时复用，避免 patch 套娃
	if (!prototype[CORE_RENDER]) {
		prototype[CORE_RENDER] = prototype.render;
	}
	const coreRender = prototype[CORE_RENDER]!;
	prototype.render = function renderCompactUserMessage(width: number): string[] {
		// 委托 pi core 原版 render，产出 [OSC_START+顶pad, 内容..., OSC_END+FINAL+底pad]；
		// 过滤上下 padding 行只留内容行(1 行，line-height 100%)，
		// 把 OSC133 标记从 padding 行剥离、移到内容行首尾。
		const raw = coreRender.call(this, Math.max(1, width - 1));
		if (raw.length === 0) return raw;
		const oscStart = raw[0].match(/^\x1b\]133;A\x07/)?.[0] ?? "";
		const oscEndFinal = raw[raw.length - 1].match(/^\x1b\]133;B\x07\x1b\]133;C\x07/)?.[0] ?? "";
		const stripped = raw.slice();
		if (oscStart) stripped[0] = stripped[0].slice(oscStart.length);
		if (oscEndFinal) stripped[stripped.length - 1] = stripped[stripped.length - 1].slice(oscEndFinal.length);
		const content = stripped.filter((line) => !visuallyBlank(line));
		if (content.length === 0) return raw.map(styleUserMessageLine);
		const styled = content.map(styleUserMessageLine);
		styled[0] = oscStart + styled[0];
		styled[styled.length - 1] = styled[styled.length - 1] + oscEndFinal;
		return styled;
	};
}
