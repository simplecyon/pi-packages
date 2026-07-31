# @simplecyon/pi-minimal-tui

Compact, low-noise rendering for Pi's built-in tool events, plus the
`cyon-minimal-dark` theme.

Built-in Bash calls receive a 30-second timeout when the model does not provide
one explicitly. Explicit timeout values are preserved; Pi interprets them as
seconds.

## What it changes

- Collapsed tool calls use a consistent `Category (detail)` shape, such as
  `• Read (extensions.md)` and `• Bash (npm test)`. File actions show only the
  final filename; search and shell actions keep a bounded intent string.
- While an agent run is active, consecutive `bash`, `read`, `grep`, `find`, and
  `ls` actions keep only the three most recent rows visible. Earlier rows use
  `⊢`, and the latest row uses `⨽`, for example `⊢ Read (Layout.tsx)` followed
  by `⨽ Grep (handleOpenPasswordDialog)`.
- When the run ends, those live rows collapse into two compact lines:
  `• Thought for 30s` and a natural-language aggregate such as
  `⨽ Read 2 files, ran 1 bash`. Thinking may occur between actions without
  splitting the batch. Visible assistant content, a user turn, an error, or a
  non-groupable tool starts a new batch.
- A single action keeps its descriptive verb-and-target row.
- Aggregated and single-action rows keep one aligned marker column. Event text
  uses the terminal's bold/semibold face as the closest available approximation
  to font weight 500.
- Bash failures stay compact while retaining outcomes such as timeout or exit
  status.
- Collapsed edits show a high-contrast compact diff with one context line, a
  single omission marker between distant change groups, and subtle
  theme-adaptive green/red backgrounds on added and removed rows. Dark themes
  use low-luminance tints; light themes use pale high-luminance tints. Only the
  gutter keeps the semantic red/green foreground; code uses Pi's syntax
  highlighter selected from the edited file extension. Each changed-row tint
  fills the complete rendered row.
- `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` use
  background-free self-rendered shells.
- When `@simplecyon/pi-safe-operation` is loaded in the same Pi runtime, the
  Bash renderer forwards partial and final output through its synchronous
  local redaction capability before rendering. Without that package, output
  behavior is unchanged.
- `Ctrl+O` continues to use Pi's native expanded state and restores full native
  output, including syntax highlighting, images, errors, timing, and complete
  diffs.
- `cyon-minimal-dark` gives user messages a subtle cool-gray highlight while
  keeping tool and custom-message surfaces quiet. User-message highlights omit
  Pi's default blank row above the content and replace the full bottom padding
  row with a quarter-height strip, making the highlight approximately 1.25×
  the text height. They also add a dim `> ` gutter and use the same
  medium-weight approximation as events. Primary text is pure white for
  stronger dark-theme contrast.

`write` is summarized as a file operation rather than shown as an invented
diff: Pi's write result does not contain the previous file content.

## Install

Install only this package:

```bash
pi install npm:@simplecyon/pi-minimal-tui
```

For one trusted project:

```bash
pi install npm:@simplecyon/pi-minimal-tui -l --approve
```

The complete suite remains available as
`git:github.com/simplecyon/pi-packages`.

Restart Pi, then select:

```text
/theme
cyon-minimal-dark
```

The extension removes tool backgrounds regardless of the active theme, except
for the deliberate shallow highlight on collapsed edit diff rows. The bundled
theme additionally tunes user-message and fallback surface colors.

## Deliberate boundaries

`Thought for …` measures the public `agent_start` → `agent_end` lifecycle, so
it is the elapsed agent-run time (including tool execution), not a model-
reported private thinking duration.

On reload, resume, or post-compaction rebuild, `session_start` replays the
branch and the coordinator re-derives each turn's elapsed time from the
persisted `SessionEntry.timestamp` values (user message → next user message /
compaction / branch end), so the `Thought for …` line survives across
restarts. Turns that begin at a compaction boundary with no preceding user
message in the branch cannot be anchored and are left without a duration.

Turns that call no tools (pure thinking + text answer) get a standalone
`• Thought for …` line appended after the answer via a non-context
`CustomEntry` (`pi.appendEntry` + `registerEntryRenderer`). The entry is
persisted and excluded from LLM context, so it survives reload without
polluting the model's prompt. Turns ending in a non-groupable tool
(`edit`/`write`) still do not host the duration on the tool itself and are
left without a label for now.

Pi 0.82.x does not expose per-message thinking timing. While a run is
streaming the package keeps Pi's native live `Thinking...` label so the user
still sees a thinking indicator; once the turn completes, the per-run
placeholder labels are stripped and the package's own `• Thought for …` takes
over. It also does not add mouse interaction.

It decorates public built-in tool definitions rather than reimplementing tool
execution. Renderer contracts can still change between Pi minor versions.

## Development

From the monorepo root:

```bash
pnpm --filter @simplecyon/pi-minimal-tui check
pi install -l --approve /absolute/path/to/pi-packages/packages/pi-minimal-tui
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
