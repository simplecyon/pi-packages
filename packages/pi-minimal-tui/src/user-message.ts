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
	if (visuallyBlank(line)) {
		// padding 行去掉背景色块，变成终端背景留白(保留 OSC133 标记)，
		// 让 user message 上下稍高但不笨重，内容行仍保留色块区分。
		return line.replace(/\x1b\[48;[0-9;]*m/g, "").replace(/\x1b\[49m/g, "");
	}

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
		// 委托 pi core 原版 render，产出上下 padding + 内容行；
		// 随后由 styleUserMessageLine 把 padding 行的背景色去掉(变终端背景留白)，
		// 只保留内容行的色块作为区分，避免上下色块过重。
		const lines = coreRender.call(this, Math.max(1, width - 1));
		return lines.map(styleUserMessageLine);
	};
}
