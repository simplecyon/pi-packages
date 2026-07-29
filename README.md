# pi-packages

Cyon's monorepo for package-only Pi extensions and themes.

## Packages

| Workspace | Package | Purpose |
| --- | --- | --- |
| `packages/pi-minimal-tui` | `pi-minimal-tui` | Minimal tool-event rendering and the `cyon-minimal-dark` theme |
| `packages/pi-memory` | `@cyon/pi-memory` | Cache-stable base memory and scope-aware progressive disclosure |
| `packages/pi-context-compact` | `@cyon/pi-context-compact` | Durable compaction checkpoints and cold-history search |
| `packages/pi-context-inspector` | `@cyon/pi-context-inspector` | `/context` context-usage inspection |
| `packages/pi-session-tasks` | `@cyon/pi-session-tasks` | Session-local structured task tracking |
| `packages/pi-skill-telemetry` | `@cyon/pi-skill-telemetry` | Privacy-preserving local skill telemetry |

`context-mode-cyon` remains outside this repository because it is an upstream
fork with its own history, build system, and release cadence.

## Install the suite

```bash
pi install git:github.com/simplecyon/pi-packages
```

During local development:

```bash
pi install -l --approve /path/to/pi-packages
```

The repository root is an aggregate Pi Package. Individual workspace packages
retain their own manifests and versions so they can also be tested or
published independently.

## Development

```bash
pnpm install --ignore-scripts
pnpm run check
```

Pi core packages are peer dependencies of the individual packages and pinned
development dependencies of the workspace. The workspace uses pnpm so its
root override can replace vulnerable transitive dependencies even when an
upstream development package publishes an npm shrinkwrap.
