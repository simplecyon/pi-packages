# Context Mode Replacement Contract

This document defines when the Pi-native package suite may replace the
user-level `context-mode` package. The target is behavioral parity for Pi, not
source or architecture parity with context-mode's multi-client MCP server.

## Scope

The replacement must preserve the useful Pi workflows while removing:

- the user-level context-mode package and its MCP child process;
- the always-on context-mode routing skill and `ctx_*` tool schemas;
- the separate SQLite runtime dependency;
- project or user settings that load context-mode.

Support for Claude Code, Gemini CLI, Copilot, OpenClaw, and other hosts is out of
scope. Those clients are not provided by `pi-packages`.

## Capability matrix

| Existing Pi workflow | Pi-native owner | Completion evidence |
| --- | --- | --- |
| Execute analysis code without replaying raw inputs | `pi-context-engine/context_run` | JavaScript and Python execution tests; bounded result path |
| Process one or many local files in code | `context_run.files` | Project-boundary, file-map, and multi-file tests |
| Index local content or files | `pi-context-engine/context_index` | Chunk, replace-by-source, persistence, and restart tests |
| Fetch then index a web resource | `context_index.url` | HTTPS, redirect, SSRF, MIME, byte-cap, and timeout tests |
| Search indexed knowledge | `pi-context-engine/context_search` | Ranked multilingual search with bounded snippets |
| Capture decisions, file operations, Git, tasks, errors, and prompts | native session ledger | Lifecycle replay tests with no raw tool arguments |
| Search compacted history | `pi-context-compact` plus unified search | Compaction/restart search test |
| Large output stays outside model context | `pi-context-artifacts` | Real Pi Bash truncation replay and exact recovery |
| Session stats and diagnostics | existing `/context`, plus `/context-engine` and `/context-doctor` | Command tests and real Pi TUI smoke |
| Import existing Pi context-mode data | `/context-migrate` | Read-only SQLite migration, dedupe, and real data count |
| Purge replacement data deliberately | `/context-purge --confirm` | Scoped destructive-command test |
| Resume after compaction and process restart | `pi-context-compact` | Stable session key and resumed branch test |

## Token-ROI constraints

- At most two context-engine schemas are active in a fresh project:
  `context_run` and `context_index`.
- `context_search` is inactive until searchable data exists.
- No active-memory block is injected every turn. Pi's native context and the
  compact continuation checkpoint remain authoritative.
- Search results and command output are bounded. Larger tool results continue
  through `pi-context-artifacts`.
- Operational commands are slash commands, not model tools.

## Cutover gates

The user-level context-mode package may be removed only after:

1. all matrix rows have direct automated evidence;
2. legacy data is copied successfully without deleting the source databases;
3. a restarted Pi session loads the suite with no context-mode extension;
4. `context_run`, index/search, compact/resume, artifacts, and ROI pass a real
   interactive smoke test;
5. `pi list` and loaded-resource output contain no context-mode package or skill;
6. the project remains usable if the legacy directory is retained read-only.
