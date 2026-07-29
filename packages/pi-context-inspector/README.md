# @simplecyon/pi-context-inspector

Context-usage diagnostics for Pi through the `/context` command.

The extension makes fixed prompt overhead visible—system instructions, context
files, skill metadata, and tool schemas—alongside conversation messages,
thinking, and the largest tool results. It helps answer whether a session needs
compaction or a smaller set of loaded resources.

## What `/context` shows

- Total context usage relative to the model's context window.
- Fixed prompt overhead grouped by system prompt, context files, skills, and
  active tool schemas.
- Conversation usage grouped by user, assistant, thinking, and tool-result
  content.
- Expandable top contributors for context files and tool results.
- Practical warnings when one category consumes a disproportionate share.

In interactive mode, `/context` opens a navigable TUI panel. In print or other
non-TUI modes, it emits a compact notification and does not instantiate TUI
components.

## Install

Install only this package:

```bash
pi install npm:@simplecyon/pi-context-inspector
```

For a trusted project-local installation:

```bash
pi install npm:@simplecyon/pi-context-inspector -l --approve
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages/packages/pi-context-inspector
```

The complete suite remains available as
`git:github.com/simplecyon/pi-packages`.

Then run:

```text
/context
```

## Measurement model

- Token estimates use Pi's own `estimateTokens` approximation.
- When provider usage is available, total input is anchored to
  `input + cacheRead + cacheWrite`; output tokens are excluded.
- Category shares are estimates. Active tool schemas are measured separately,
  and remaining unmatched input is displayed as estimation residual.
- Character-based estimates can undercount Chinese text, so category
  proportions are directional rather than billing-grade measurements.
- Base memory already present in the system prompt is not counted again when
  `@simplecyon/pi-memory` records its session metadata.

See [`RESEARCH.md`](RESEARCH.md) for source-level research and
[`REQUIREMENTS.md`](REQUIREMENTS.md) for the product specification.

## Known limitations

- Transient context-event rewrites that are never persisted may not appear as a
  separate category.
- Recommendation thresholds are currently built in.
- There is no JSON export mode.

## Compatibility

Targets Pi 0.82.x and integrates with `@simplecyon/pi-memory`.

## Development

From the monorepo root:

```bash
pnpm --filter @simplecyon/pi-context-inspector check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
