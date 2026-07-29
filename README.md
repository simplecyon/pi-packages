# pi-minimal-tui

Compact, background-free rendering for Pi's built-in tool events.

## What it changes

- Collapsed tool calls render as one line: `·read docs: extensions.md`
- `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` use a background-free self-rendered shell
- `Ctrl+O` still expands and collapses tool details through Pi's native `expanded` state
- Expanded output keeps Pi's built-in renderers, including diff, syntax highlighting, truncation notices, images, errors, and bash timing
- The included `cyon-minimal-dark` theme gives user messages a weak cool-gray highlight while keeping custom-message and fallback tool surfaces background-free

The package deliberately does not simulate Thinking duration, automatic Thinking collapse, or mouse interaction. Pi 0.82.1 does not expose those interactive-core hooks to packages.

## Install in Pi

Install directly from GitHub:

```bash
pi install git:github.com/simplecyon/pi-minimal-tui
```

Install for one trusted project so Pi can restore it on a new device:

```bash
pi install git:github.com/simplecyon/pi-minimal-tui -l --approve
```

Pi clones the repository and runs the package dependency install itself. No
manual checkout or separate `npm install` is required.

Restart Pi, then select:

```text
/theme
cyon-minimal-dark
```

## Develop locally

```bash
npm install
npm run check
pi install /absolute/path/to/Side-Project/pi/pi-minimal-tui
```

The extension itself removes tool backgrounds regardless of the active theme. The bundled theme keeps user messages visually distinct with a weak background while neutralizing custom-message and fallback tool background tokens.

## Compatibility

This first version targets `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 0.82.x. It decorates public built-in tool definitions rather than reimplementing tool execution, but renderer contracts may still change between Pi minor versions.
