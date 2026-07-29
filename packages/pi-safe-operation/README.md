# @simplecyon/pi-safe-operation

Operation safety and secret-egress guardrails for
[Pi](https://github.com/earendil-works/pi).

The extension creates two runtime boundaries:

- **Action boundary** — blocks structurally unsafe deletion, protects configured
  paths, confirms destructive Git/system operations, and provides recoverable
  `safe_delete`.
- **Data-egress boundary** — redacts credentials in tool results, context, and
  the final provider payload before they reach the model.

## Install

```bash
pi install npm:@simplecyon/pi-safe-operation
```

The complete `simplecyon/pi-packages` Git package also includes this extension.
For a trusted project-local install:

```bash
pi install npm:@simplecyon/pi-safe-operation -l --approve
```

Restart Pi after installation.

## Behavior

- Raw delete commands must be standalone and use explicit targets.
- Compound deletion, generated targets, globs, variables, and command
  substitution are blocked.
- Batches that mix files/directories or tracked/non-tracked targets are blocked
  and must be split.
- Permanent deletion, destructive Git actions, privilege escalation, recursive
  permission changes, disk operations, and package removal require approval.
- `safe_delete(paths, reason)` moves approved project targets to
  `.trash/pi-safe-operation/<timestamp>/` and writes a recovery manifest.
- Private-key reads are blocked.
- Text from `read`, `bash`, `grep`, custom tools, context, and provider payloads
  is deterministically redacted locally.
- Repeated occurrences of one secret receive the same session-scoped HMAC
  fingerprint without exposing the original value or a reusable hash.
- Print and JSON modes fail closed whenever interactive approval is required.

Run `/safe` to view session counters.

## Project configuration

Create `.pi/safe-operation.json` in a trusted project:

```json
{
  "version": 1,
  "mode": "balanced",
  "protectedPaths": [".git", ".pi/safe-operation.json"],
  "noDeletePaths": [".pi"],
  "sensitivePaths": [".env*", "credentials*.json"],
  "knowledgeDirs": ["docs", "notes"],
  "maxExplicitTargets": 50,
  "recoverableDelete": true,
  "redaction": {
    "enabled": true,
    "maxSecretDensity": 0.3,
    "scanToolResults": true,
    "scanFinalContext": true
  }
}
```

An optional user baseline can be stored at
`~/.pi/agent/safe-operation.json`. Project configuration may add stricter
rules, but cannot disable the user's redaction boundary or raise destructive
operation limits.

## Security boundary

The extension runs inside Pi and is not an OS sandbox. V1 guarantees that
sanitized final tool results and provider payloads reach the model. Bash
streaming updates may still briefly display raw output in the local TUI before
the final result is redacted.

Secret detection is deterministic and local; it never sends raw data to
another model or network service.
