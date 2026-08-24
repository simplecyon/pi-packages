# @simplecyon/pi-cache-trace

Adds privacy-preserving, session-scoped diagnostics for provider prompt-cache
behavior. It records metadata-only `cache-trace` custom entries and exposes a
`/cache-trace` summary command.

Each completed assistant request records salted fingerprints for the system
instructions, active tool schema, request cache key, and the shared prefix of
provider input items. It also records request/response metadata and provider
usage (`input`, `cacheRead`, `cacheWrite`). Prompts, user messages, tool
arguments, tool results, credentials, and raw cache keys are never persisted.

Use `/cache-trace` to inspect total traced requests, cache-read rate, full
misses, and the most recent request. The extension writes no standalone log
files and its custom entries never enter model context.
