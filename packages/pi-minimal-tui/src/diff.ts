import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type CompactDiffLineKind = "added" | "removed" | "context" | "omission";

export interface CompactDiffLine {
	kind: CompactDiffLineKind;
	text: string;
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
			return theme.fg("toolDiffAdded", line.text);
		case "removed":
			return theme.fg("toolDiffRemoved", line.text);
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
