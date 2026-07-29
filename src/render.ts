import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolSummary } from "./summary.ts";

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

function indentLine(line: string, width: number): string {
	if (width <= 2) return truncateToWidth(stripBackgroundAnsi(line), width);
	return truncateToWidth(`  ${stripBackgroundAnsi(line)}`, width);
}

function summaryLine(summary: ToolSummary, theme: Theme, width: number): string {
	const bullet = theme.fg("muted", "·");
	const verb = theme.fg("toolTitle", summary.verb);
	const detail = summary.detail ? ` ${theme.fg("muted", summary.detail)}` : "";
	return truncateToWidth(`${bullet}${verb}${detail}`, width);
}

export class MinimalToolCallComponent implements Component {
	private summary: ToolSummary;
	private inner: Component | undefined;
	private expanded: boolean;
	private theme: Theme;

	constructor(summary: ToolSummary, inner: Component | undefined, expanded: boolean, theme: Theme) {
		this.summary = summary;
		this.inner = inner;
		this.expanded = expanded;
		this.theme = theme;
	}

	update(summary: ToolSummary, inner: Component | undefined, expanded: boolean, theme: Theme): void {
		this.summary = summary;
		this.inner = inner;
		this.expanded = expanded;
		this.theme = theme;
	}

	render(width: number): string[] {
		const lines = [summaryLine(this.summary, this.theme, width)];
		if (!this.expanded || !this.inner || width <= 0) return lines;

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

	constructor(inner: Component | undefined, visible: boolean) {
		this.inner = inner;
		this.visible = visible;
	}

	update(inner: Component | undefined, visible: boolean): void {
		this.inner = inner;
		this.visible = visible;
	}

	render(width: number): string[] {
		if (!this.visible || !this.inner || width <= 0) return [];
		const rendered = trimEmptyEdges(this.inner.render(Math.max(1, width - 2)).map(stripBackgroundAnsi));
		return rendered.map((line) => indentLine(line, width));
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

export function renderedWidth(lines: readonly string[]): number {
	return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
