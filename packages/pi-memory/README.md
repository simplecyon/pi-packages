# @cyon/pi-memory

Package-only, scoped `MEMORY.md` injection for Pi.

The extension keeps stable memory in the system-prompt prefix, progressively
discloses directory-specific memory as the agent works, and prevents the first
mutation in an unread scope from running before the model has received that
scope's memory.

## Memory model

### Base snapshot

At the start of an agent turn, the cache-stable base snapshot may contain:

- `~/.pi/agent/MEMORY.md`
- the project-root `MEMORY.md`
- the nearest `MEMORY.md` for the initial working directory

Each file appears once in the active context epoch.

### Progressive disclosure

- Read-only tools (`read`, `grep`, `find`, `ls`, and recognized non-mutating
  shell commands) may discover a new scope. Its memory is delivered after the
  tool result.
- Before the first `write`, `edit`, or recognized mutating shell command in an
  unread scope, the extension blocks that tool call, queues the relevant memory
  as a steering message, and asks the agent to retry.
- Returning to a previously injected scope does not trigger another block.
- Moving between several directories therefore does not repeatedly interrupt
  the agent.

### Refresh and compaction

- Memory content hashes detect changed files and make those scopes eligible for
  reinjection.
- Active memory messages are reconstructed from Pi's compaction-aware session
  context.
- Only memories removed from active context need to be disclosed again.
- Each memory file is capped at 12,000 characters using middle truncation.

## Install

Install only this package:

```bash
pi install npm:@cyon/pi-memory
```

For a trusted project-local installation:

```bash
pi install npm:@cyon/pi-memory -l --approve
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages/packages/pi-memory
```

The complete suite remains available as
`git:github.com/simplecyon/pi-packages`.

## Commands

| Command | Effect |
| --- | --- |
| `/memory` | Show current memory state |
| `/memory refresh` | Mark memory for refresh |
| `/memory off` | Disable injection for the current session |
| `/memory on` | Re-enable injection |

Disable injection at process startup:

```bash
PI_NO_MEMORY_INJECTION=1 pi
```

Override the agent directory in isolated environments or tests:

```bash
PI_MEMORY_AGENT_DIR=/absolute/path pi
```

## Compatibility

The package emits `memory-injection:base-loaded` for
`@cyon/pi-context-inspector` and announces the
`cyon:memory:available` capability to compatible extensions.

Targets Pi 0.82.x.

## Development

From the monorepo root:

```bash
pnpm --filter @cyon/pi-memory check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
