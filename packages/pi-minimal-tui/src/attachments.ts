import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const REMOVE_ATTACHMENT_KEY = "alt+backspace";

// Bracketed paste control sequences used to intercept pastes at the input layer.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Keep Pi's native large-paste collapse: anything above these thresholds is
// handed back to the base editor so it folds into a `[paste #N …]` marker.
const LARGE_PASTE_LINES = 10;
const LARGE_PASTE_CHARS = 1000;

// Markdown link forms we accept when extracting attachment paths:
//   [filename](<path with spaces/()>)  and  [filename](/plain/path)
const MARKDOWN_LINK_ANGLED = /^\[[^\]]+\]\(<([^>]+)>\)$/;
const MARKDOWN_LINK_PLAIN = /^\[[^\]]+\]\(([^)]+)\)$/;

// Slash-token and skill-token patterns merged from @simplecyon/pi-skill-anywhere
// so the attachment editor also triggers mid-line skill completion and
// highlights /skill: tokens without fighting over the editor slot.
const SLASH_TOKEN_RE = /(?:^|\s)(\/\S*)$/;
const SKILL_TOKEN_RE = /\/skill:[A-Za-z0-9][A-Za-z0-9-]*/g;

interface ThemeWithFg {
	fg?: (color: string, text: string) => string;
}

export interface Attachment {
	path: string;
	name: string;
	size: number;
	mimeType?: string;
}

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveCandidatePath(value: string, cwd: string): string | undefined {
	const unquoted = unquotePath(value);
	if (!isAbsolute(unquoted) && !unquoted.startsWith("./") && !unquoted.startsWith("../")) return undefined;
	return resolve(cwd, unquoted);
}

/** Resolve a standalone editor line to a file path, accepting raw paths and `[name](path)` markdown links. */
function resolveCandidatePathFromLine(line: string, cwd: string): string | undefined {
	const trimmed = line.trim();
	const angled = trimmed.match(MARKDOWN_LINK_ANGLED);
	if (angled) return resolveCandidatePath(angled[1], cwd);
	const plain = trimmed.match(MARKDOWN_LINK_PLAIN);
	if (plain) return resolveCandidatePath(plain[1], cwd);
	return resolveCandidatePath(line, cwd);
}

function candidatePaths(text: string, cwd: string): string[] {
	return text.split(/\r?\n/).map((value) => resolveCandidatePathFromLine(value, cwd)).filter((value): value is string => Boolean(value));
}

/** Wrap a markdown link target in angle brackets when it would break link syntax. */
function markdownTarget(path: string): string {
	return /[\s<>()]/.test(path) ? `<${path}>` : path;
}

function isLargePaste(text: string): boolean {
	return text.split("\n").length > LARGE_PASTE_LINES || text.length > LARGE_PASTE_CHARS;
}

/**
 * Fold standalone file-path lines into `[filename]` tokens, recording the
 * name → path mapping used to expand them back at the output boundary. The
 * editor stores the short tokens (compact display), while `getText()` and
 * `getExpandedText()` expand them into full `[filename](filepath)` links so
 * Pi still submits the complete path. Non-path lines pass through untouched.
 */
export function foldPathLines(text: string, cwd: string, map: Map<string, string[]>): string {
	return text
		.split(/\r?\n/)
		.map((line) => {
			const filePath = resolveCandidatePath(line, cwd);
			if (!filePath) return line;
			try {
				if (!existsSync(filePath) || !statSync(filePath).isFile()) return line;
				const name = basename(filePath);
				if (name.includes("]")) return line;
				const paths = map.get(name) ?? [];
				paths.push(filePath);
				map.set(name, paths);
				return `[${name}]`;
			} catch {
				return line;
			}
		})
		.join("\n");
}

/** Expand `[filename]` fold tokens back into `[filename](filepath)` links. */
function expandFoldedText(text: string, map: Map<string, string[]>): string {
	const occurrences = new Map<string, number>();
	return text
		.split(/\r?\n/)
		.map((line) => {
			const match = line.match(/^\[([^\]]+)\]$/);
			if (!match) return line;
			const name = match[1];
			const paths = map.get(name);
			if (!paths || paths.length === 0) return line;
			const index = occurrences.get(name) ?? 0;
			occurrences.set(name, index + 1);
			if (index >= paths.length) return line;
			return `[${name}](${markdownTarget(paths[index])})`;
		})
		.join("\n");
}

/** Extract readable files pasted as standalone editor lines. */
export function collectAttachments(text: string, cwd: string): Attachment[] {
	const attachments = new Map<string, Attachment>();
	for (const filePath of candidatePaths(text, cwd)) {
		try {
			if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
			const extension = extname(filePath).toLowerCase();
			attachments.set(filePath, {
				path: filePath,
				name: basename(filePath),
				size: statSync(filePath).size,
				mimeType: IMAGE_MIME_TYPES[extension],
			});
		} catch {
			// A file may disappear between paste and render; omit its card.
		}
	}
	return [...attachments.values()];
}

/**
 * Stores pasted file paths as short `[filename]` fold tokens so the editor
 * stays compact, renders attachment cards above the editor, and expands the
 * tokens into full `[filename](filepath)` links at the text boundary so Pi
 * submits the complete path. Large pastes keep Pi's native `[paste #N …]`
 * collapse.
 */
// @ts-expect-error - overrides private insertCharacter; works at runtime via jiti
// (merged from pi-skill-anywhere)
export class AttachmentComposer extends CustomEditor {
	private attachments: Attachment[] = [];
	private previewCache = new Map<string, { mtimeMs: number; data: string }>();
	private pendingPasteMode = false;
	private pendingPasteBuffer = "";
	private pathByFoldName = new Map<string, string[]>();

	/** Set by the factory on each construction; reads the live app theme for skill highlighting. */
	getTheme: () => ThemeWithFg | undefined = () => undefined;

	insertTextAtCursor(text: string): void {
		super.insertTextAtCursor(foldPathLines(text, process.cwd(), this.pathByFoldName));
		this.syncAttachments();
	}

	getText(): string {
		return expandFoldedText(super.getText(), this.pathByFoldName);
	}

	getExpandedText(): string {
		return expandFoldedText(super.getExpandedText(), this.pathByFoldName);
	}

	// Pi's submit path and getExpandedText() both feed state.lines through
	// expandPasteMarkers and skip getText(), so intercepting it here is the
	// single chokepoint that guarantees fold tokens are expanded on submit.
	expandPasteMarkers(text: string): string {
		// @ts-expect-error - super.expandPasteMarkers is private; accessible at runtime
		return expandFoldedText(super.expandPasteMarkers(text), this.pathByFoldName);
	}

	handleInput(data: string): void {
		if (matchesKey(data, REMOVE_ATTACHMENT_KEY) && this.attachments.length > 0) {
			this.removeLastAttachment();
			return;
		}
		// Intercept bracketed paste so standalone file paths become compact
		// `[name]` fold tokens at paste time. Large pastes are replayed verbatim
		// so Pi's native `[paste #N …]` collapse is kept.
		if (data.includes(PASTE_START)) {
			this.pendingPasteMode = true;
			this.pendingPasteBuffer = "";
			data = data.replace(PASTE_START, "");
		}
		if (this.pendingPasteMode) {
			this.pendingPasteBuffer += data;
			const endIndex = this.pendingPasteBuffer.indexOf(PASTE_END);
			if (endIndex !== -1) {
				const pasteContent = this.pendingPasteBuffer.substring(0, endIndex);
				const remaining = this.pendingPasteBuffer.substring(endIndex + PASTE_END.length);
				this.pendingPasteMode = false;
				this.pendingPasteBuffer = "";
				if (pasteContent.length > 0) {
					if (isLargePaste(pasteContent)) {
						super.handleInput(`${PASTE_START}${pasteContent}${PASTE_END}`);
					} else {
						super.insertTextAtCursor(foldPathLines(pasteContent, process.cwd(), this.pathByFoldName));
						this.syncAttachments();
					}
				}
				if (remaining.length > 0) this.handleInput(remaining);
			}
			return;
		}
		super.handleInput(data);
		this.syncAttachments();
	}

	render(width: number): string[] {
		this.syncAttachments();
		const cards = this.renderCards(width);
		const lines = super.render(width);
		// Skill-token highlighting (merged from pi-skill-anywhere). Defensive:
		// a highlight failure must never break input rendering.
		try {
			const theme = this.getTheme();
			if (theme && typeof theme.fg === "function") {
				const fg = theme.fg.bind(theme);
				return [...cards, ...lines.map((line) => line.replace(SKILL_TOKEN_RE, (tok) => fg("accent", tok)))];
			}
		} catch {
			// Fall through to unhighlighted rendering.
		}
		return [...cards, ...lines];
	}

	insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		// @ts-expect-error - super.insertCharacter is private; accessible at runtime
		super.insertCharacter(char, skipUndoCoalescing);
		// Trigger slash completion for "/" tokens at any position — mid-line
		// (after whitespace) AND at line start — so skills can be invoked from
		// anywhere in the input line. Merged from pi-skill-anywhere.
		try {
			// @ts-expect-error - autocompleteState is private; accessible at runtime
			if (this.autocompleteState) return;
			// @ts-expect-error - state is private; accessible at runtime
			const line = this.state.lines[this.state.cursorLine] || "";
			// @ts-expect-error - state is private; accessible at runtime
			const before = line.slice(0, this.state.cursorCol);
			if (SLASH_TOKEN_RE.test(before)) {
				// @ts-expect-error - tryTriggerAutocomplete is private; accessible at runtime
				this.tryTriggerAutocomplete();
			}
		} catch {
			// Never let trigger logic break input editing.
		}
	}

	private syncAttachments(): void {
		this.attachments = collectAttachments(this.getExpandedText?.() ?? this.getText(), process.cwd());
	}

	private removeLastAttachment(): void {
		const attachment = this.attachments.at(-1);
		if (!attachment) return;
		const lines = super.getText().split(/\r?\n/);
		// Attachments created from pasted paths live as `[name]` fold tokens;
		// manually typed raw-path lines stay raw. Remove the matching line for
		// whichever form this attachment took.
		const folded = [...this.pathByFoldName.values()].some((paths) => paths.includes(attachment.path));
		let lastIndex = -1;
		if (folded) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim() === `[${attachment.name}]`) lastIndex = i;
			}
		} else {
			for (let i = 0; i < lines.length; i++) {
				if (resolveCandidatePathFromLine(lines[i], process.cwd()) === attachment.path) lastIndex = i;
			}
		}
		if (lastIndex === -1) return;
		lines.splice(lastIndex, 1);
		this.setText(lines.join("\n"));
		this.syncAttachments();
	}

	private renderCards(width: number): string[] {
		if (this.attachments.length === 0) return [];
		const lines: string[] = [];
		for (const attachment of this.attachments) {
			const label = attachment.mimeType ? "IMG" : "FILE";
			const detail = attachment.mimeType ?? (extname(attachment.name).slice(1).toUpperCase() || "file");
			lines.push(truncateToWidth(`  ${label}  ${attachment.name}  · ${detail} · ${formatSize(attachment.size)}`, width));
			if (attachment.mimeType && getCapabilities().images && attachment.size <= MAX_PREVIEW_BYTES) {
				const preview = this.getPreview(attachment);
				if (preview) {
					lines.push(...new Image(preview, attachment.mimeType, { fallbackColor: (value) => value }, {
						filename: attachment.name,
						maxHeightCells: 6,
						maxWidthCells: Math.min(24, width),
					}).render(width));
				}
			}
		}
		lines.push(truncateToWidth(`  ${REMOVE_ATTACHMENT_KEY} removes the last attachment`, width));
		return lines;
	}

	private getPreview(attachment: Attachment): string | undefined {
		try {
			const stats = statSync(attachment.path);
			const cached = this.previewCache.get(attachment.path);
			if (cached?.mtimeMs === stats.mtimeMs) return cached.data;
			const data = readFileSync(attachment.path).toString("base64");
			this.previewCache.set(attachment.path, { mtimeMs: stats.mtimeMs, data });
			return data;
		} catch {
			return undefined;
		}
	}
}
