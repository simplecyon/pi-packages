# @simplecyon/pi-skill-anywhere

Invoke pi skills from anywhere in the input line.

## Features

1. **Slash menu at any position** — typing `/` after whitespace (not only at line start) triggers the skill autocomplete menu. Mid-line the menu is restricted to skills only; line-start keeps pi's default menu (all commands + skills + paths).

2. **Clean system-prompt injection** — a mid-line `/skill:name` token is left in place as a visible declaration in the user message. The skill content is injected into the system prompt via `before_agent_start` — no `<skill>` block in the user message, no split display. `_expandSkillCommand` skips it (text doesn't start with `/skill:`), so the token stays visible.

3. **Highlighted skill tokens** — recognized `/skill:name` tokens are highlighted in the input box with the theme's accent color.

## How it works

When you type `分析 /skill:ink 写文章` and submit:

- The `input` handler detects `/skill:ink`, locates the skill file (`<cwd>/.agents/skills/<name>/SKILL.md` or `~/.agents/skills/<name>/SKILL.md`), and stores it — but does **not** modify the text. The token stays visible as a declaration.
- `_expandSkillCommand` returns the text as-is (it doesn't start with `/skill:`).
- `before_agent_start` reads the skill file, strips frontmatter, builds a `<skill>` block (identical format to pi's own `_expandSkillCommand`), and appends it to the system prompt.
- Result: user message shows `分析 /skill:ink 写文章` (token visible), skill content in system prompt, no `[skill] ink` split component in the TUI.

### Fallback

If the skill file can't be located in `.agents/skills/` (e.g. pi-package skills under `~/.pi/agent/git/`), the token is lifted to the front so pi's own line-start expansion handles it natively — the skill is still invoked, just with the standard split display.

## Install

```bash
pi update --extension git:github.com/simplecyon/pi-packages
```

Or add to your project's `.pi/` configuration manually.

## License

MIT
