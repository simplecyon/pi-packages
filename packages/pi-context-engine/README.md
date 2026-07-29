# @simplecyon/pi-context-engine

Pi-native replacement for the useful Pi workflows previously provided by the
user-level context-mode MCP package.

The extension intentionally exposes only three model tools:

- `context_run` executes JavaScript or Python analysis in a child process. An
  optional project-local file list is loaded into `FILES`, with the first file
  also exposed as `FILE_CONTENT`.
- `context_index` indexes supplied text, a project-local file/directory, or a
  fetched HTTP(S) text resource.
- `context_search` searches indexed documents and the native session ledger.
  It is inactive until searchable records exist.

Commands:

```text
/context-engine
/context-doctor
/context-migrate
/context-purge --confirm
```

`/context-migrate` copies matching Pi data from
`~/.pi/context-mode/{sessions,content}` using read-only SQLite access. It never
deletes or modifies the legacy databases.

The store defaults to `~/.pi/agent/context-engine/`, uses project-scoped files
and user-only permissions. Native session capture stores only bounded,
redacted semantic events rather than raw tool arguments. The explicit legacy
migration preserves redacted context-mode record bodies so prior searches
remain useful.
