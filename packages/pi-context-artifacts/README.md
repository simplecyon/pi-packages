# @simplecyon/pi-context-artifacts

Safety-gated bounded tool output and durable exact recovery for Pi.

The extension stores a large, already-redacted text result outside model
context and replaces it with a bounded head/tail preview plus an artifact ID.
It activates `artifact_read` only after an artifact exists, so fresh sessions
pay no retrieval-tool schema cost.

`artifact_read` supports exact offset/limit recovery and bounded text search
within one artifact.

Repeated large results with the same redacted content reuse the existing
artifact instead of writing another copy.

Artifact creation remains disabled unless `@simplecyon/pi-safe-operation`
announces that tool-result redaction is active. Installing this package alone
therefore cannot silently persist unredacted output.

Default policy:

- always archive results estimated at 24,000 tokens or more;
- under at least 65% context pressure, archive results at 8,000 tokens or more;
- preserve about 3,000 tokens in the model-visible preview;
- never archive errors, images, or artifact/compaction recovery results.

The visible budget is clamped to at most half of the smallest archive
threshold. Storage is a durability gate: if persistence or preview generation
fails, the original tool result passes through unchanged.

Environment overrides:

```text
PI_CONTEXT_ARTIFACTS_DIR
PI_CONTEXT_ARTIFACTS_HARD_TOKENS
PI_CONTEXT_ARTIFACTS_PRESSURE_TOKENS
PI_CONTEXT_ARTIFACTS_PRESSURE_PERCENT
PI_CONTEXT_ARTIFACTS_VISIBLE_TOKENS
```

Commands:

```text
/artifacts
```

Artifacts default to `~/.pi/agent/context-artifacts/`. Files are created with
user-only permissions. They contain redacted tool-result text and minimal
metadata, never tool arguments or result details.
