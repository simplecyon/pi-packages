# @simplecyon/pi-memory

Package-only, scoped project-memory injection and maintenance routing for Pi.

The extension keeps stable memory in the system-prompt prefix, progressively
discloses directory-specific memory as the agent works, and prevents the first
mutation in an unread scope from running before the model has received that
scope's memory. It also retrieves relevant `.memory/*.md` topic files from user
input and bundles the `memory-maintainer` skill.

## Memory model

### Base snapshot

At the start of an agent turn, the cache-stable base snapshot may contain:

- `~/.pi/agent/MEMORY.md`
- the project-root `MEMORY.md`
- the nearest `MEMORY.md` for the initial working directory

Each file appears once in the active context epoch.

When the base snapshot is first injected, the TUI shows a durable,
context-free event such as `✦ 读取了 2 份记忆`. Repeated agent turns with the
same snapshot do not add duplicate events.

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
- A newly disclosed scope renders as `✦ 读取了 <scope> 记忆`; `Ctrl+O` reveals
  the injected memory content.

### Discrete memory recall

- The `input` hook captures ordinary interactive and RPC user prompts without
  transforming their text.
- Before the agent starts, a deterministic local matcher searches `.memory`
  directories on the project-root-to-cwd scope chain.
- Filename, heading, indexed `triggers`, indexed `use when`, and body matches
  receive separate weights. Indexed triggers are strongest.
- Generic turns and slash commands are skipped. Automatic recall requires a
  minimum score; multi-token queries must match at least two distinct tokens.
  It selects at most two files and uses an 8,000-character budget.
- Files larger than 64 KiB, symlinks, paths outside the owning `.memory`
  directory, and candidates after the 200-file limit are ignored.
- A recall renders as `✦ 召回了 N 份离散记忆`; `Ctrl+O` shows paths, scores,
  match reasons, and injected content.
- `memory_search` provides explicit bounded search for the agent without
  injecting the results automatically.

An owning `MEMORY.md` can improve recall precision with an index entry:

```md
- Automation and sync: see `.memory/automation-git-sync.md`
  - triggers: scheduled job stuck, git sync, 自动化, 时区
  - use when: a scheduled report fails or repository synchronization breaks
```

### Memory maintenance

The package exposes the `memory-maintainer` skill. Its metadata routes only
when the user explicitly asks to remember, persist, update, consolidate, move,
delete, or otherwise maintain project memory. Projects that need a mandatory
policy can add a short append-system invariant requiring this skill before
memory writes; the full workflow remains progressively disclosed in the skill.

The skill uses normal read/edit/write tools, keeps topic files indexed from the
nearest `MEMORY.md`, and requires explicit confirmation for deletion,
overwrite, and MOVE. The extension does not provide a privileged memory writer.

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
pi install npm:@simplecyon/pi-memory
```

For a trusted project-local installation:

```bash
pi install npm:@simplecyon/pi-memory -l --approve
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
| `/memory recall <query>` | Explicitly retrieve and inject discrete memory |
| `/memory explain` | Explain the most recent discrete-memory match |
| `/memory off` | Disable injection for the current session |
| `/memory on` | Re-enable injection |

Model tool:

```text
memory_search(query, limit?)
```

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
`@simplecyon/pi-context-inspector` and announces the
`cyon:memory:available` capability to compatible extensions.

Targets Pi 0.82.x.

## Development

From the monorepo root:

```bash
pnpm --filter @simplecyon/pi-memory check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
