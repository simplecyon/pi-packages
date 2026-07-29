# @simplecyon/pi-minimal-tui

Compact, low-noise rendering for Pi's built-in tool events, plus the
`cyon-minimal-dark` theme.

## What it changes

- Collapsed tool calls render as one descriptive line, such as
  `• read docs: extensions.md`.
- Consecutive `bash`, `read`, `grep`, `find`, and `ls` actions within one
  execution batch collapse into a count summary. A new Thinking segment,
  visible assistant content, user turn, error, or non-groupable tool starts a
  new batch.
- A single action keeps its descriptive verb-and-target row.
- Aggregated and single-action rows share the same larger `• ` marker and text
  column. Event text uses the terminal's bold/semibold face as the closest
  available approximation to font weight 500.
- Bash failures stay compact while retaining outcomes such as timeout or exit
  status.
- Collapsed edits show a high-contrast compact diff with one context line, a
  single omission marker between distant change groups, and subtle
  theme-adaptive green/red backgrounds on added and removed rows. Dark themes
  use low-luminance tints; light themes use pale high-luminance tints. Only the
  gutter keeps the semantic red/green foreground; code uses Pi's syntax
  highlighter selected from the edited file extension.
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
  Pi's default blank row above the content while retaining one bottom padding
  row, add a dim `> ` gutter, and use the same medium-weight approximation as
  events. Primary text is pure white for stronger dark-theme contrast.

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

The package does not simulate thinking duration, automatic thinking collapse,
or mouse interaction because Pi 0.82.x does not expose those interactive-core
hooks to packages.

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
