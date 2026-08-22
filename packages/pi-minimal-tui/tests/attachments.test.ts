import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import minimalTuiExtension from "../src/index.ts";
import {
	AttachmentComposer,
	collectAttachments,
	expandPendingAttachmentTokens,
	foldPathLines,
	parseWindowsFileDropList,
} from "../src/attachments.ts";

function createComposer(): AttachmentComposer {
	const tui = { terminal: { rows: 24 } } as any;
	const theme = { borderColor: (value: string) => value } as any;
	const keybindings = { matches: () => false } as any;
	return new AttachmentComposer(tui, theme, keybindings);
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

test("parses Windows FileDropList JSON without accepting malformed clipboard output", () => {
	assert.deepEqual(parseWindowsFileDropList(`"C:\\\\Users\\\\Cyon\\\\Desktop\\\\one.png"`), ["C:\\Users\\Cyon\\Desktop\\one.png"]);
	assert.deepEqual(
		parseWindowsFileDropList(`["C:\\\\Users\\\\Cyon\\\\Desktop\\\\one.png","D:\\\\docs\\\\two.pdf"]`),
		["C:\\Users\\Cyon\\Desktop\\one.png", "D:\\docs\\two.pdf"],
	);
	assert.deepEqual(parseWindowsFileDropList("not-json"), []);
});

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

test("installs the attachment composer unconditionally as the editor", () => {
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
	// Even when another extension already owns the slot, the attachment
	// composer must take over so pasted files fold (skill-anywhere yields).
	onSessionStart?.({}, {
		ui: {
			theme: undefined,
			getEditorComponent: () => () => ({}),
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

test("foldPathLines rewrites standalone file-path lines into fold tokens", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		const spaced = join(cwd, "my file.txt");
		await writeFile(image, "png");
		await writeFile(spaced, "txt");

		const map = new Map<string, string[]>();
		const folded = foldPathLines(`Explain these:\n${image}\n./my file.txt\n${join(cwd, "missing.pdf")}\ncat ${image}`, cwd, map);
		assert.equal(folded, `Explain these:\n[clipboard.png]\n[my file.txt]\n${join(cwd, "missing.pdf")}\ncat ${image}`);
		assert.deepEqual(map.get("clipboard.png"), [image]);
		assert.deepEqual(map.get("my file.txt"), [spaced]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("collectAttachments accepts markdown link lines and ignores non-file links", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const spaced = join(cwd, "my file.txt");
		const image = join(cwd, "clipboard.png");
		await writeFile(spaced, "txt");
		await writeFile(image, "png");
		const attachments = collectAttachments(
			`[clipboard.png](${image})\n[my file.txt](<${spaced}>)\n[website](https://example.com)`,
			cwd,
		);
		assert.deepEqual(attachments, [
			{ path: join(cwd, "clipboard.png"), name: "clipboard.png", size: 3, mimeType: "image/png" },
			{ path: spaced, name: "my file.txt", size: 3, mimeType: undefined },
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("pasting a file path stores a fold token and expands it in getText", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		assert.equal(editor.getText(), `[clipboard.png](${image})`);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("editor renders the fold token instead of the full path", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		const rendered = editor.render(80).join("\n");
		assert.match(rendered, /\[clipboard\.png\]/);
		assert.ok(!rendered.includes(image), "rendered output must not leak the raw path");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("expanding the folded text is idempotent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		const expanded = editor.getText();
		// Round-trip: setting expanded text back must not double-expand.
		editor.setText(expanded);
		assert.equal(editor.getText(), expanded);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("submit path expands fold tokens into full paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}Explain:\n${image}${PASTE_END}`);
		let submitted: string | undefined;
		editor.onSubmit = (text) => { submitted = text; };
		// Pi's submitValue() reads state.lines directly and only routes through
		// expandPasteMarkers — the composer must expand there, not via getText.
		(editor as any).submitValue();
		assert.equal(submitted, `Explain:\n[clipboard.png](${image})`);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("input-stage recovery expands the latest folded attachment token once", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		assert.equal(
			expandPendingAttachmentTokens("[clipboard.png] please review"),
			`[clipboard.png](${image}) please review`,
		);
		assert.equal(expandPendingAttachmentTokens("[clipboard.png]"), "[clipboard.png]");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("expansion leaves existing Markdown attachment links intact", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		assert.equal(editor.getText(), `[clipboard.png](${image})`);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("getExpandedText expands fold tokens for follow-up and external-editor paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${image}${PASTE_END}`);
		assert.equal(editor.getExpandedText(), `[clipboard.png](${image})`);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("alt+backspace removes the last pasted attachment line", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const first = join(cwd, "a.png");
		const second = join(cwd, "b.pdf");
		await writeFile(first, "png");
		await writeFile(second, "pdf");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}${first}\n${second}${PASTE_END}`);
		assert.equal(editor.getText(), `[a.png](${first})\n[b.pdf](${second})`);
		editor.handleInput("\x1b\x7f"); // alt+backspace
		assert.equal(editor.getText(), `[a.png](${first})`);
		editor.handleInput("\x1b\x7f");
		assert.equal(editor.getText(), "");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("pasting mixed content folds path lines and leaves other lines untouched", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-tui-attachments-"));
	try {
		const image = join(cwd, "clipboard.png");
		await writeFile(image, "png");
		const editor = createComposer();
		editor.handleInput(`${PASTE_START}Explain these:\n${image}\nThanks${PASTE_END}`);
		assert.equal(editor.getText(), `Explain these:\n[clipboard.png](${image})\nThanks`);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("pasting plain text and large pastes keeps Pi's native behavior", async () => {
	const plain = createComposer();
	plain.handleInput(`${PASTE_START}hello world${PASTE_END}`);
	assert.equal(plain.getText(), "hello world");

	const large = createComposer();
	large.handleInput(`${PASTE_START}${"x".repeat(1200)}${PASTE_END}`);
	assert.match(large.getText(), /^\[paste #\d+ \d+ chars\]$/);
});
