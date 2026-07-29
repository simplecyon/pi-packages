# pi-minimal-tui

Compact, background-free rendering for Pi's built-in tool events, plus the
`cyon-minimal-dark` theme.

## What it changes

- Collapsed tool calls render as one descriptive line, such as
  `·read docs: extensions.md`.
- Consecutive `bash`, `read`, `grep`, `find`, and `ls` actions collapse into a
  count summary.
- A single action keeps its descriptive verb-and-target row.
- Bash failures stay compact while retaining outcomes such as timeout or exit
  status.
- Collapsed edits show a high-contrast compact diff with one context line and
  a single omission marker between distant change groups.
- `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` use
  background-free self-rendered shells.
- `Ctrl+O` continues to use Pi's native expanded state and restores full native
  output, including syntax highlighting, images, errors, timing, and complete
  diffs.
- `cyon-minimal-dark` gives user messages a subtle cool-gray highlight while
  keeping tool and custom-message surfaces quiet.

`write` is summarized as a file operation rather than shown as an invented
diff: Pi's write result does not contain the previous file content.

## Install

`pi-minimal-tui` now ships from the aggregate monorepo:

```bash
pi install git:github.com/simplecyon/pi-packages
```

For one trusted project:

```bash
pi install git:github.com/simplecyon/pi-packages -l --approve
```

Restart Pi, then select:

```text
/theme
cyon-minimal-dark
```

The extension removes tool backgrounds regardless of the active theme; the
bundled theme additionally tunes user-message and fallback surface colors.

## Deliberate boundaries

The package does not simulate thinking duration, automatic thinking collapse,
or mouse interaction because Pi 0.82.x does not expose those interactive-core
hooks to packages.

It decorates public built-in tool definitions rather than reimplementing tool
execution. Renderer contracts can still change between Pi minor versions.

## Development

From the monorepo root:

```bash
pnpm --filter pi-minimal-tui check
pi install -l --approve /absolute/path/to/pi-packages
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
