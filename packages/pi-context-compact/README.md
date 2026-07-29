# @cyon/pi-context-compact

Standalone, package-only context compaction for Pi.

It stores messages leaving the active context in an append-only local history,
replaces Pi's generated summary with a bounded continuation checkpoint, and
registers `compact_search` for on-demand recovery. Successful TUI compactions
show a compact completion notice with the pre-compact token count and archived
message count.

Only tool results explicitly marked as runtime errors are promoted into the
checkpoint's unresolved-error section. Error-related words in documentation or
source code do not create false blockers.

## Install

```bash
pi install /path/to/Side-Project/pi/context-compact
```

The default history root is:

```text
~/.pi/agent/context-compact/
```

Set `PI_CONTEXT_COMPACT_DIR` to override it, including in tests.

## Compatibility

The package does not require context-mode. When a compatible context-mode
extension is also loaded, an event-bus capability handshake tells context-mode
to skip its duplicate resume snapshot.
