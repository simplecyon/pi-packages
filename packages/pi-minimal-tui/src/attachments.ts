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

function candidatePaths(text: string, cwd: string): string[] {
	return text.split(/\r?\n/).map((value) => resolveCandidatePath(value, cwd)).filter((value): value is string => Boolean(value));
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
 * Keeps Pi's editor semantics unchanged while making pasted file paths visible
 * as removable attachment cards. Pi still submits the original paths as text.
 */
export class AttachmentComposer extends CustomEditor {
	private attachments: Attachment[] = [];
	private previewCache = new Map<string, { mtimeMs: number; data: string }>();

	insertTextAtCursor(text: string): void {
		super.insertTextAtCursor(text);
		this.syncAttachments();
	}

	handleInput(data: string): void {
		if (matchesKey(data, REMOVE_ATTACHMENT_KEY) && this.attachments.length > 0) {
			this.removeLastAttachment();
			return;
		}
		super.handleInput(data);
		this.syncAttachments();
	}

	render(width: number): string[] {
		this.syncAttachments();
		const cards = this.renderCards(width);
		return [...cards, ...super.render(width)];
	}

	private syncAttachments(): void {
		this.attachments = collectAttachments(this.getExpandedText?.() ?? this.getText(), process.cwd());
	}

	private removeLastAttachment(): void {
		const attachment = this.attachments.at(-1);
		if (!attachment) return;
		const text = this.getExpandedText?.() ?? this.getText();
		const remainingLines = text
			.split(/\r?\n/)
			.filter((line) => resolveCandidatePath(line, process.cwd()) !== attachment.path);
		this.setText(remainingLines.join("\n"));
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
