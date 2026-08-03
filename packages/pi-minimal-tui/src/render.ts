import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolSummary } from "./summary.ts";
import type { GroupView } from "./grouping.ts";

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function withoutBackgroundParams(rawParams: string): string {
	const params = rawParams === "" ? [0] : rawParams.split(";").map((value) => Number(value || 0));
	const kept: number[] = [];

	for (let index = 0; index < params.length; index += 1) {
		const value = params[index] ?? 0;
		if (value === 48) {
			const mode = params[index + 1];
			if (mode === 5) {
				index += 2;
				continue;
			}
			if (mode === 2) {
				index += 4;
				continue;
			}
			continue;
		}
		if ((value >= 40 && value <= 49) || (value >= 100 && value <= 107)) continue;
		kept.push(value);
	}

	return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
}

export function stripBackgroundAnsi(text: string): string {
	const withoutBackground = text.replace(SGR_PATTERN, (_sequence, params: string) => withoutBackgroundParams(params));
	return withoutBackground.replace(/[ \t]+(?=(?:\x1b\[[0-9;]*m)*$)/, "");
}

function plainText(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function visuallyEmpty(text: string): boolean {
	return plainText(text).trim().length === 0;
}

function trimEmptyEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && visuallyEmpty(lines[start] ?? "")) start += 1;
	while (end > start && visuallyEmpty(lines[end - 1] ?? "")) end -= 1;
	return lines.slice(start, end);
}

function indentLine(line: string, width: number, preserveBackground = false): string {
	const rendered = preserveBackground ? line : stripBackgroundAnsi(line);
	if (width <= 2) return truncateToWidth(rendered, width);
	if (preserveBackground) {
		const withIndentedBackground = rendered.replace(/^(\x1b\[(?:4[0-9]|10[0-7]|48;(?:5;\d+|2;\d+;\d+;\d+))m)/, "$1  ");
		if (withIndentedBackground !== rendered) return truncateToWidth(withIndentedBackground, width);
	}
	return truncateToWidth(`  ${rendered}`, width);
}

function summaryLine(
	summary: ToolSummary,
	theme: Theme,
	width: number,
	outcome?: string,
	marker?: GroupView["marker"],
): string {
	const markerText = marker === "middle" ? "⊢ " : marker === "last" ? "⨽ " : "• ";
	const bullet = summary.bullet === false ? "" : theme.fg("muted", markerText);
	const verb = theme.fg("toolTitle", summary.verb);
	const detail = summary.detail ? ` ${theme.fg("muted", `(${summary.detail})`)}` : "";
	const base = `${bullet}${theme.bold(`${verb}${detail}`)}`;
	if (!outcome) return truncateToWidth(base, width);

	const suffix = theme.fg("error", ` × ${outcome}`);
	const suffixWidth = visibleWidth(suffix);
	if (suffixWidth >= width) return truncateToWidth(suffix.trimStart(), width);
	return `${truncateToWidth(base, width - suffixWidth)}${suffix}`;
}

export function formatThoughtDuration(elapsedMs: number): string {
	const seconds = Math.max(1, Math.round(elapsedMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export class ThoughtLineComponent implements Component {
	private elapsedMs: number;
	private theme: Theme;

	constructor(elapsedMs: number, theme: Theme) {
		this.elapsedMs = elapsedMs;
		this.theme = theme;
	}

	render(width: number): string[] {
		return [
			truncateToWidth(
				`${this.theme.fg("muted", "• ")}${this.theme.fg(
					"thinkingText",
					`Thought for ${formatThoughtDuration(this.elapsedMs)}`,
				)}`,
				width,
			),
		];
	}

	invalidate(): void {}
}

interface MinimalToolCallOptions {
	getGroupView?: () => GroupView | undefined;
	outcome?: string;
	approval?: () => string | undefined;
	showInnerCollapsed?: boolean;
}

export class MinimalToolCallComponent implements Component {
	private summary: ToolSummary;
	private inner: Component | undefined;
	private expanded: boolean;
	private theme: Theme;
	private options: MinimalToolCallOptions;

	constructor(
		summary: ToolSummary,
		inner: Component | undefined,
		expanded: boolean,
		theme: Theme,
		options: MinimalToolCallOptions = {},
	) {
		this.summary = summary;
		this.inner = inner;
		this.expanded = expanded;
		this.theme = theme;
		this.options = options;
	}

	update(
		summary: ToolSummary,
		inner: Component | undefined,
		expanded: boolean,
		theme: Theme,
		options: MinimalToolCallOptions = {},
	): void {
		this.summary = summary;
		this.inner = inner;
		this.expanded = expanded;
		this.theme = theme;
		this.options = options;
	}

	render(width: number): string[] {
		const groupView = this.expanded ? undefined : this.options.getGroupView?.();
		if (groupView?.hidden) return [];
		const summary = groupView?.summary ?? this.summary;
		const lines =
			groupView?.elapsedMs === undefined
				? []
				: [
						truncateToWidth(
							`${this.theme.fg("muted", "• ")}${this.theme.fg(
								"thinkingText",
								`Thought for ${formatThoughtDuration(groupView.elapsedMs)}`,
							)}`,
							width,
						),
					];
		lines.push(summaryLine(summary, this.theme, width, this.options.outcome, groupView?.marker));
		const approval = this.options.approval?.();
		if (approval) lines.push(truncateToWidth(this.theme.fg("muted", `⨽ ${approval}`), width));
		// ToolExecutionComponent supplies a leading spacer, but adjacent messages
		// do not get one. Add a trailing spacer only at a message boundary, so
		// consecutive action events do not acquire extra blank rows.
		if (!this.expanded && groupView?.separateFromMessage) lines.push("");
		if ((!this.expanded && !this.options.showInnerCollapsed) || !this.inner || width <= 0) return lines;

		const rendered = trimEmptyEdges(this.inner.render(Math.max(1, width - 2)).map(stripBackgroundAnsi));
		const headerIndex = rendered.findIndex((line) => !visuallyEmpty(line));
		const body = headerIndex >= 0 ? trimEmptyEdges(rendered.slice(headerIndex + 1)) : [];
		for (const line of body) lines.push(indentLine(line, width));
		return lines;
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

export class MinimalToolResultComponent implements Component {
	private inner: Component | undefined;
	private visible: boolean;
	private preserveBackground: boolean;

	constructor(inner: Component | undefined, visible: boolean, preserveBackground = false) {
		this.inner = inner;
		this.visible = visible;
		this.preserveBackground = preserveBackground;
	}

	update(inner: Component | undefined, visible: boolean, preserveBackground = false): void {
		this.inner = inner;
		this.visible = visible;
		this.preserveBackground = preserveBackground;
	}

	render(width: number): string[] {
		if (!this.visible || !this.inner || width <= 0) return [];
		const sanitize = this.preserveBackground ? (line: string) => line : stripBackgroundAnsi;
		const rendered = trimEmptyEdges(this.inner.render(Math.max(1, width - 2)).map(sanitize));
		return rendered.map((line) => indentLine(line, width, this.preserveBackground));
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

export function renderedWidth(lines: readonly string[]): number {
	return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
