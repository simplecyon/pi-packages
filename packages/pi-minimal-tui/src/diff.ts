import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type CompactDiffLineKind = "added" | "removed" | "context" | "omission";

export interface CompactDiffLine {
	kind: CompactDiffLineKind;
	text: string;
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const ANSI_16_COLORS: readonly Rgb[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

function ansi256ToRgb(index: number): Rgb {
	if (index < 16) return ANSI_16_COLORS[index] ?? { r: 0, g: 0, b: 0 };
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const cube = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return {
		r: levels[Math.floor(cube / 36)] ?? 0,
		g: levels[Math.floor((cube % 36) / 6)] ?? 0,
		b: levels[cube % 6] ?? 0,
	};
}

function rgbToAnsi256({ r, g, b }: Rgb): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round((r - 8) / 10) + 232;
	}
	const toCube = (value: number) => Math.round((value / 255) * 5);
	return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

function rgbFromAnsi(ansi: string): Rgb | undefined {
	const truecolor = ansi.match(/\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
	if (truecolor) {
		return {
			r: Number(truecolor[1]),
			g: Number(truecolor[2]),
			b: Number(truecolor[3]),
		};
	}
	const indexed = ansi.match(/\[(?:38|48);5;(\d+)m/);
	return indexed ? ansi256ToRgb(Number(indexed[1])) : undefined;
}

function mix(base: Rgb, tint: Rgb, tintRatio: number): Rgb {
	const channel = (baseValue: number, tintValue: number) =>
		Math.round(baseValue * (1 - tintRatio) + tintValue * tintRatio);
	return {
		r: channel(base.r, tint.r),
		g: channel(base.g, tint.g),
		b: channel(base.b, tint.b),
	};
}

function isLightBackground({ r, g, b }: Rgb): boolean {
	return r * 0.299 + g * 0.587 + b * 0.114 >= 160;
}

function semanticBackground(
	theme: Theme,
	color: "toolDiffAdded" | "toolDiffRemoved",
	text: string,
): string {
	if (
		typeof theme.getBgAnsi !== "function" ||
		typeof theme.getFgAnsi !== "function" ||
		typeof theme.getColorMode !== "function"
	) {
		return theme.bg("selectedBg", text);
	}
	const base = rgbFromAnsi(theme.getBgAnsi("selectedBg"));
	const tint = rgbFromAnsi(theme.getFgAnsi(color));
	if (!base || !tint) return theme.bg("selectedBg", text);

	const light = isLightBackground(base);
	const neutral = light ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	const surface = mix(base, neutral, light ? 0.7 : 0.6);
	const background = mix(surface, tint, light ? 0.12 : 0.22);
	const ansi =
		theme.getColorMode() === "truecolor"
			? `\x1b[48;2;${background.r};${background.g};${background.b}m`
			: `\x1b[48;5;${rgbToAnsi256(background)}m`;
	return `${ansi}${text}\x1b[49m`;
}

function parseDiffLine(line: string): CompactDiffLine {
	const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
	if (!match) return { kind: "context", text: line };

	const prefix = match[1];
	const content = match[3] ?? "";
	if (prefix === "+") return { kind: "added", text: line };
	if (prefix === "-") return { kind: "removed", text: line };
	if (content.trim() === "...") return { kind: "omission", text: "  …" };
	return { kind: "context", text: line };
}

function isChange(line: CompactDiffLine): boolean {
	return line.kind === "added" || line.kind === "removed";
}

/**
 * Keep every changed line, one nearby context line by default, and replace each
 * skipped region with one omission marker. The input is Pi's display diff.
 */
export function compactDiffLines(diffText: string, contextLines = 1): CompactDiffLine[] {
	const lines = diffText.split("\n").map(parseDiffLine);
	const changedIndexes = lines.flatMap((line, index) => (isChange(line) ? [index] : []));
	if (!changedIndexes.length) return lines;

	const keep = new Set<number>(changedIndexes);
	for (const changedIndex of changedIndexes) {
		for (let distance = 1; distance <= contextLines; distance += 1) {
			const before = changedIndex - distance;
			const after = changedIndex + distance;
			if (before >= 0 && lines[before]?.kind === "context") keep.add(before);
			if (after < lines.length && lines[after]?.kind === "context") keep.add(after);
		}
	}

	const keptIndexes = [...keep].sort((left, right) => left - right);
	const compacted: CompactDiffLine[] = [];
	let previousIndex = -1;
	for (const index of keptIndexes) {
		if (index > previousIndex + 1 && compacted.at(-1)?.kind !== "omission") {
			compacted.push({ kind: "omission", text: "  …" });
		}
		const line = lines[index];
		if (line) compacted.push(line);
		previousIndex = index;
	}
	if (previousIndex < lines.length - 1 && compacted.at(-1)?.kind !== "omission") {
		compacted.push({ kind: "omission", text: "  …" });
	}
	return compacted;
}

function colorLine(line: CompactDiffLine, theme: Theme): string {
	switch (line.kind) {
		case "added":
			return semanticBackground(theme, "toolDiffAdded", theme.fg("toolDiffAdded", line.text));
		case "removed":
			return semanticBackground(theme, "toolDiffRemoved", theme.fg("toolDiffRemoved", line.text));
		case "omission":
			return theme.fg("dim", line.text);
		default:
			return theme.fg("toolDiffContext", line.text);
	}
}

export class CompactDiffComponent implements Component {
	private diffText: string;
	private theme: Theme;

	constructor(diffText: string, theme: Theme) {
		this.diffText = diffText;
		this.theme = theme;
	}

	update(diffText: string, theme: Theme): void {
		this.diffText = diffText;
		this.theme = theme;
	}

	render(): string[] {
		return compactDiffLines(this.diffText).map((line) => colorLine(line, this.theme));
	}

	invalidate(): void {}
}
