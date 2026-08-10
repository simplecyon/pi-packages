import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import minimalTuiExtension from "../src/index.ts";
import { collectAttachments } from "../src/attachments.ts";

test("collectAttachments recognizes pasted absolute image and file paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		const document = join(cwd, "notes.pdf");
		await writeFile(image, "png");
		await writeFile(document, "pdf-file");

		const attachments = collectAttachments(`Explain these files:\n${image}\n${document}`, cwd);
		assert.deepEqual(attachments, [
			{ path: image, name: "clipboard.png", size: 3, mimeType: "image/png" },
			{ path: document, name: "notes.pdf", size: 8, mimeType: undefined },
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("installs the attachment composer when no other editor owns the slot", () => {
	let onSessionStart: ((event: unknown, context: any) => void) | undefined;
	let factory: unknown;
	const pi = {
		on(name: string, handler: (event: unknown, context: any) => void) {
			if (name === "session_start") onSessionStart = handler;
		},
		events: { on() { return () => {}; }, emit() {} },
		registerTool() {},
		registerEntryRenderer() {},
		appendEntry() {},
	};
	minimalTuiExtension(pi as any);
	onSessionStart?.({}, {
		ui: {
			getEditorComponent: () => undefined,
			setEditorComponent: (next: unknown) => { factory = next; },
		},
		sessionManager: { getBranch: () => [] },
	});
	assert.equal(typeof factory, "function");
});

test("collectAttachments resolves quoted relative paths and ignores unavailable paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		await writeFile(join(cwd, "photo.webp"), "webp");
		const attachments = collectAttachments(`"./photo.webp"\n./missing.txt\nnot a path`, cwd);
		assert.deepEqual(attachments, [
			{ path: join(cwd, "photo.webp"), name: "photo.webp", size: 4, mimeType: "image/webp" },
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
