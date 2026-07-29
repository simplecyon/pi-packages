# @cyon/pi-memory

Package-only scoped `MEMORY.md` injection for Pi.

It keeps global and project memory in a cache-stable system-prompt snapshot,
progressively discloses the nearest directory-scoped memory, and prevents the
first mutation in an unread scope from running before that memory reaches the
model.

## Behavior

- Base memory: `~/.pi/agent/MEMORY.md`, project-root `MEMORY.md`, and the
  nearest cwd scope are injected through `before_agent_start`.
- Read-only discovery: `read`, `grep`, `find`, `ls`, and non-mutating `bash`
  disclose a newly entered scope after the tool result.
- Mutation preflight: the first `write`, `edit`, or recognized mutating `bash`
  in a new scope is blocked. The scope memory is queued with
  `deliverAs: "steer"` and the agent retries on its next turn.
- Residency: a scope is injected once per active context epoch, not every time
  the agent switches directories.
- Refresh: changed memory hashes become stale and are disclosed again.
- Compaction: active custom memory messages are reconstructed from Pi's
  compaction-aware session context; only memories actually removed from context
  need to be disclosed again.
- Each injected file is capped at 12,000 characters with middle truncation.

## Install

```bash
pi install /path/to/Side-Project/pi/pi-memory
```

For a project-local install:

```bash
pi install -l --approve /path/to/Side-Project/pi/pi-memory
```

## Commands

```text
/memory
/memory refresh
/memory off
/memory on
```

Disable injection for one process with:

```bash
PI_NO_MEMORY_INJECTION=1 pi
```

## Compatibility

The package emits the existing `memory-injection:base-loaded` event for
`pi-context-inspector` compatibility and also announces the
`cyon:memory:available` capability.
