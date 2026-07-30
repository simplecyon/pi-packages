# pi-packages

Cyon's package-only extensions and themes for
[Pi](https://github.com/earendil-works/pi), maintained as one monorepo.

## Packages

| Workspace | Package | Purpose |
| --- | --- | --- |
| [`packages/pi-ask-user-question`](packages/pi-ask-user-question) | `@simplecyon/pi-ask-user-question` | Structured human-in-the-loop questions with exclusive TUI focus |
| [`packages/pi-minimal-tui`](packages/pi-minimal-tui) | `@simplecyon/pi-minimal-tui` | Compact tool-event rendering and the `cyon-minimal-dark` theme |
| [`packages/pi-memory`](packages/pi-memory) | `@simplecyon/pi-memory` | Scoped memory injection, deterministic `.memory` recall, and maintenance skill |
| [`packages/pi-safe-operation`](packages/pi-safe-operation) | `@simplecyon/pi-safe-operation` | Destructive-operation safety, recoverable deletion, and secret-egress redaction |
| [`packages/pi-context-compact`](packages/pi-context-compact) | `@simplecyon/pi-context-compact` | Durable compaction checkpoints and cold-history search |
| [`packages/pi-context-engine`](packages/pi-context-engine) | `@simplecyon/pi-context-engine` | Pi-native context execution, indexing, search, continuity, and legacy migration |
| [`packages/pi-context-artifacts`](packages/pi-context-artifacts) | `@simplecyon/pi-context-artifacts` | Safety-gated bounded output with durable exact recovery |
| [`packages/pi-context-inspector`](packages/pi-context-inspector) | `@simplecyon/pi-context-inspector` | `/context` diagnostics for prompt and conversation usage |
| [`packages/pi-context-core`](packages/pi-context-core) | `@simplecyon/pi-context-core` | Model-invisible token accounting and context primitives |
| [`packages/pi-token-roi`](packages/pi-token-roi) | `@simplecyon/pi-token-roi` | Observe-only `/roi` economics and JSON export |
| [`packages/pi-session-tasks`](packages/pi-session-tasks) | `@simplecyon/pi-session-tasks` | Session-local, branch-aware structured task tracking |
| [`packages/pi-skill-telemetry`](packages/pi-skill-telemetry) | `@simplecyon/pi-skill-telemetry` | Privacy-preserving local skill usage telemetry |

The former project-level `context-mode-cyon` package has been replaced by
independently implemented capabilities in this suite. This repository does not
import it, require it, or assume its storage format; see
[Token ROI architecture](docs/token-roi.md).

## Install separately

Every workspace is an independent public npm package:

```bash
pi install npm:@simplecyon/pi-ask-user-question
pi install npm:@simplecyon/pi-minimal-tui
pi install npm:@simplecyon/pi-memory
pi install npm:@simplecyon/pi-safe-operation
pi install npm:@simplecyon/pi-context-compact
pi install npm:@simplecyon/pi-context-engine
pi install npm:@simplecyon/pi-context-artifacts
pi install npm:@simplecyon/pi-context-inspector
pi install npm:@simplecyon/pi-token-roi
pi install npm:@simplecyon/pi-session-tasks
pi install npm:@simplecyon/pi-skill-telemetry
```

Add `-l --approve` to any command for a trusted project-local installation.

## Install the suite

Install the complete suite from GitHub:

```bash
pi install git:github.com/simplecyon/pi-packages
```

Install it for one trusted project:

```bash
pi install git:github.com/simplecyon/pi-packages -l --approve
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages
```

The repository root is an aggregate Git package. Its manifest exposes all eleven
extensions, the bundled `memory-maintainer` skill, and the theme.
`pi-context-core` is a library dependency and
does not load as an extension. The npm packages are separate distribution units
with independent manifests, versions, tests, and compatibility boundaries.

After installation, restart Pi. Use `/theme` to select
`cyon-minimal-dark`; package commands such as `/memory`, `/context`,
`/context-engine`, `/context-doctor`, `/artifacts`, `/roi`, `/tasks`, and `/skill-stats` become available
automatically.

## Requirements

- Node.js 22.19 or newer
- Pi `@earendil-works/pi-*` 0.82.x
- A trusted project when loading project-local extensions

## Development

This repository uses pnpm workspaces:

```bash
pnpm install --ignore-scripts
pnpm run check
pnpm run release:dry-run
```

Run one package only:

```bash
pnpm --filter @simplecyon/pi-memory check
pnpm --filter @simplecyon/pi-minimal-tui check
```

`pnpm run check` runs every workspace's typecheck and tests, then verifies that
Pi's real resource loader can load the aggregate package without duplicate or
invalid resources.

Pi core packages are peer dependencies of individual packages and pinned
development dependencies of the workspace. The root pnpm override keeps
vulnerable transitive development dependencies out of the lockfile even when
an upstream package publishes an npm shrinkwrap. Pi's Git installer uses
production-only dependencies when consuming this repository.

See [Releasing packages](docs/releasing.md) for first-publish setup, versioning,
dry runs, and npm Trusted Publishing.

## Repository policy

- Package code belongs under `packages/<name>/`.
- Cross-package loading behavior belongs in `tests/`.
- Package-specific behavior and commands are documented in that package's
  README.
- The repository does not contain or depend on `context-mode-cyon`.
- Vault-specific guard extensions remain outside this repository.

## License

MIT
