# @cyon/pi-context-compact

Package-only durable context compaction for Pi.

When Pi compacts a session, this extension stores the messages leaving active
context in append-only local history and replaces the generated summary with a
bounded continuation checkpoint. Older material remains recoverable through
the `compact_search` tool instead of being replayed into every model request.

## Behavior

- Writes archived session messages to append-only local storage.
- Produces a bounded checkpoint containing continuation state and retrieval
  pointers.
- Includes only explicitly failed tool results in the unresolved-error section;
  words such as "error" in source code or documentation are not treated as
  runtime failures.
- Registers `compact_search` for bounded keyword recovery from cold history.
- Falls back to Pi's native compaction if durable storage fails.
- Shows a compact TUI completion notice with the pre-compaction token count and
  archived message count.

## Install

Install only this package:

```bash
pi install npm:@cyon/pi-context-compact
```

For a trusted project-local installation:

```bash
pi install npm:@cyon/pi-context-compact -l --approve
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages/packages/pi-context-compact
```

The complete suite remains available as
`git:github.com/simplecyon/pi-packages`.

## Storage

The default history directory is:

```text
~/.pi/agent/context-compact/
```

Override it for testing or isolated environments:

```bash
PI_CONTEXT_COMPACT_DIR=/absolute/path pi
```

History is local and append-only. Search returns bounded snippets rather than
injecting an entire archived tool result back into context.

## Compatibility

The package does not require a context-mode extension. When a compatible
context-mode package is present, an event-bus capability handshake asks it to
skip its duplicate resume snapshot.

Targets Pi 0.82.x.

## Development

From the monorepo root:

```bash
pnpm --filter @cyon/pi-context-compact check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
