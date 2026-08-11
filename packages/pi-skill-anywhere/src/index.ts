/**
 * skill-anywhere — invoke pi skills from anywhere in the input line.
 *
 * 1. Slash menu triggers at any token position (after whitespace), not only
 *    at line start. Mid-line the menu is restricted to skills only.
 * 2. On submit, a mid-line `/skill:name` token is left in place as a visible
 *    declaration in the user message. The skill content is injected into the
 *    system prompt via before_agent_start — no <skill> block in the user
 *    message, no split display. _expandSkillCommand skips it (text doesn't
 *    start with /skill:), so the token stays visible. If the skill file can't
 *    be located (e.g. pi-package skills), falls back to lifting the token to
 *    the front so pi's own expansion handles it natively.
 * 3. Recognized `/skill:name` tokens are highlighted in the input box.
 *
 * The autocomplete wrapper delegates to the base provider for line-start and
 * file-path completion, so default behavior is untouched. Mid-line it asks the
 * base provider for command matches against the slash token; if the base
 * returns nothing (e.g. "/Users" is a path), it falls back to the base with
 * the original lines so path completion still works. The editor highlight is a
 * defensive post-process of super.render() wrapped in try/catch so a highlight
 * bug can never break input editing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";

// A slash command token: / followed by non-space chars, with start-or-space
// before it. Absolute paths like /Users still match this token regex, but the
// provider disambiguates them by asking the base provider for command matches.
const SLASH_TOKEN_RE = /(?:^|\s)(\/\S*)$/;
// A recognized skill invocation token in rendered text.
const SKILL_TOKEN_RE = /\/skill:[A-Za-z0-9][A-Za-z0-9-]*/g;
// A mid-line skill token in submitted text (for the submit transform).
const MIDLINE_SKILL_RE = /(?:^|\s)(\/skill:[A-Za-z0-9][A-Za-z0-9-]*)/;

// ── Skill file lookup & frontmatter stripping ──────────────────────────
// Only searches pi's own skill directories (project + user). The skill name is
// validated by MIDLINE_SKILL_RE (alphanumeric + hyphens only), so there is no
// path-traversal surface. This mirrors exactly what pi's own resourceLoader
// does when discovering skills — reading SKILL.md from these trusted dirs.
// If a skill lives elsewhere (e.g. a pi-package skill under ~/.pi/agent/git/),
// findSkillFile returns null and the input handler falls back to lifting the
// token to the front so pi handles it natively.
function findSkillFile(skillName: string, cwd: string): string | null {
	const candidates = [
		join(cwd, ".agents", "skills", skillName, "SKILL.md"),
		join(homedir(), ".agents", "skills", skillName, "SKILL.md"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

// Exact replica of pi's utils/frontmatter.js stripFrontmatter: normalizes
// newlines, drops a leading YAML frontmatter block (--- ... ---), returns body.
function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;
	return normalized.slice(endIndex + 4).trim();
}

// Set by the input handler when a mid-line skill is detected in the user
// message; consumed and cleared by the before_agent_start handler.
let pendingSkill: { name: string; filePath: string; baseDir: string } | null = null;

interface ThemeWithFg {
	fg?: (color: string, text: string) => string;
}

// ── Part 1: autocomplete provider wrapper ───────────────────────────────

class SkillAnywhereProvider implements AutocompleteProvider {
	private base: AutocompleteProvider;

	constructor(base: AutocompleteProvider) {
		this.base = base;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol);

		// Is the cursor at the end of a slash token (possibly mid-line)?
		const matchArr = before.match(SLASH_TOKEN_RE);
		if (!matchArr || matchArr.length < 2) {
			// No slash token at cursor — default behavior (paths, @mentions, etc.).
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		}
		const token = matchArr[1] as string;
		const tokenStart = before.length - token.length;
		const atLineStart = before.slice(0, tokenStart).trim() === "";

		// Line start: keep pi's default menu (all commands + skills + paths).
		if (atLineStart) {
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		// Mid-line: ask the base provider whether the token is a command prefix.
		// Use a synthetic single-line buffer so the base's startsWith("/") check
		// passes and it returns slash-command items. Force:false ensures the
		// base's slash branch (gated on !options.force) always runs, even when
		// the editor triggered completion explicitly (Ctrl+Space passes force).
		const synth = await this.base.getSuggestions([token], 0, token.length, {
			signal: options.signal,
			force: false,
		});
		if (!synth || synth.items.length === 0) {
			// Not a command prefix (e.g. "/Users") — fall back to path completion
			// using the original lines so absolute paths still complete.
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		}
		// Mid-line, only skills are actually invokable.
		const skillItems = synth.items.filter((it) => it.value.startsWith("skill:"));
		if (skillItems.length === 0) return null;
		return { items: skillItems, prefix: token };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] ?? "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);

		// Line start: delegate to the base provider's default completion.
		if (beforePrefix.trim() === "" && prefix.startsWith("/")) {
			return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		// Mid-line: replace only the slash token, preserving the text before it.
		const afterCursor = line.slice(cursorCol);
		const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;
		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length + 2, // +"/" and trailing space
		};
	}
}

// ── Part 3: editor with highlighted skill tokens ───────────────────────

// @ts-expect-error - overrides private insertCharacter; works at runtime via jiti
class SkillAnywhereEditor extends CustomEditor {
	/** Set by the factory on each construction; reads the live app theme. */
	getTheme: () => ThemeWithFg | undefined = () => undefined;

	/**
	 * Override insertCharacter so that typing "/" (or continuing to type after a
	 * mid-line "/") triggers the slash autocomplete menu — not only at line
	 * start. The base editor's own trigger logic restricts "/" to
	 * isAtStartOfMessage() and explicitly excludes "/" from trigger characters,
	 * so mid-line the provider's getSuggestions is never called. We call super
	 * first (preserving all undo/onChange/state logic), then trigger if the
	 * base didn't already and a mid-line slash token is at the cursor.
	 */
	insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		// @ts-expect-error - super.insertCharacter is private; accessible at runtime
		super.insertCharacter(char, skipUndoCoalescing);
		try {
			// @ts-expect-error - autocompleteState is private; accessible at runtime
			if (this.autocompleteState) return;
			// @ts-expect-error - state is private; accessible at runtime
			const line = this.state.lines[this.state.cursorLine] || "";
			// @ts-expect-error - state is private; accessible at runtime
			const before = line.slice(0, this.state.cursorCol);
			// Trigger slash completion for mid-line "/" tokens (preceded by
			// whitespace) too, not just at the start of the message.
			// @ts-expect-error - isAtStartOfMessage is private; accessible at runtime
			if (!this.isAtStartOfMessage() && SLASH_TOKEN_RE.test(before)) {
				// @ts-expect-error - tryTriggerAutocomplete is private; accessible at runtime
				this.tryTriggerAutocomplete();
			}
		} catch {
			// Never let trigger logic break input editing.
		}
	}

	render(width: number): string[] {
		try {
			const lines = super.render(width);
			const theme = this.getTheme();
			if (!theme || typeof theme.fg !== "function") return lines;
			// CRITICAL: bind() the fg method to the theme object. If we detach it
			// (const fg = theme.fg) the inner `this.fgColors` becomes undefined
			// and fg() throws, which the catch block swallows — producing no
			// highlight at all (the original bug).
			const fg = theme.fg.bind(theme);
			return lines.map((line) => line.replace(SKILL_TOKEN_RE, (tok) => fg("accent", tok)));
		} catch {
			// Never let highlighting break input editing.
			return super.render(width);
		}
	}
}

// ── extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Part 1: autocomplete wrapper.
		ctx.ui.addAutocompleteProvider((base) => new SkillAnywhereProvider(base));

		// Part 3: install the highlighting editor. The factory receives the
		// editor-scoped theme (EditorTheme, borderColor only); we additionally
		// hand it a getter for the full app theme. Capture the theme object
		// reference here (while ctx is active) rather than closing over ctx
		// itself — ctx.ui is a lazy getter that re-validates on every access,
		// and the theme singleton stays valid regardless of ctx lifecycle.
		const fullTheme = ctx.ui.theme as unknown as ThemeWithFg | undefined;
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new SkillAnywhereEditor(tui, theme, kb);
			editor.getTheme = () => fullTheme;
			return editor;
		});

		// Visible startup marker so the user can confirm the extension loaded.
		try {
			ctx.ui.setStatus("skill-anywhere", "ready");
		} catch {
			// setStatus not available in this ctx — non-fatal.
		}
	});

	// Part 2: on submit, detect a mid-line /skill:name token, store it for
	// before_agent_start, but DON'T modify the text — the token stays visible
	// in the user message as a declaration. _expandSkillCommand skips it (text
	// doesn't start with /skill:), so no <skill> block is injected into the
	// user message. If the skill file can't be located, fall back to lifting
	// the token to the front so pi's own expansion handles it natively.
	pi.on("input", (event, ctx) => {
		const text = event.text;
		if (!text) return;
		// Already line-start — pi handles it natively.
		if (text.startsWith("/skill:")) return;
		const m = text.match(MIDLINE_SKILL_RE);
		if (!m || m.length < 1) return;
		const fullToken = m[1] as string; // "/skill:name"
		const skillName = fullToken.slice("/skill:".length);
		// Try to locate the skill file so we can inject it separately.
		const cwd = ctx.cwd;
		const filePath = findSkillFile(skillName, cwd);
		if (filePath) {
			// Found — store for before_agent_start. DON'T transform the text:
			// leave "/skill:name" visible in the user message as a declaration.
			pendingSkill = { name: skillName, filePath, baseDir: dirname(filePath) };
			return; // no transform — text passes through unchanged
		}
		// Not found (e.g. pi-package skill) — fall back to lift so pi handles it.
		pendingSkill = null;
		const rest = text.replace(fullToken, "").replace(/\s{2,}/g, " ").trim();
		const transformed = rest ? `${fullToken} ${rest}` : fullToken;
		return { action: "transform", text: transformed };
	});

	// Part 4: inject a mid-line-invoked skill into the system prompt so the user
	// message stays clean (token visible but no <skill> block). The skill block
	// uses the exact same format as pi's own _expandSkillCommand. pendingSkill
	// is set by the input handler above and cleared here regardless of outcome.
	// If pendingSkill is null (no mid-line skill, or fallback to pi-native),
	// return nothing so the base prompt is used.
	pi.on("before_agent_start", (event) => {
		const pending = pendingSkill;
		pendingSkill = null; // always clear — one-shot, never stale
		if (!pending) return;
		try {
			const content = readFileSync(pending.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${pending.name}" location="${pending.filePath}">\nReferences are relative to ${pending.baseDir}.\n\n${body}\n</skill>`;
			return { systemPrompt: `${event.systemPrompt}\n\n${skillBlock}` };
		} catch {
			// Can't read the skill file — skip injection, user message already clean.
			return;
		}
	});
}
