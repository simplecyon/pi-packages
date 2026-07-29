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
- `safe_trash_list(limit?)` lists valid manifests and remaining targets.
- `safe_restore(manifest, paths?, reason)` restores approved targets
  transactionally and never overwrites an existing destination.
- Private-key reads are blocked.
- The built-in Bash tool is wrapped so partial streaming updates and final
  results are redacted before runtime rendering; `read`, `grep`, custom tools,
  context, and provider payloads receive additional deterministic local passes.
- Repeated occurrences of one secret receive the same session-scoped HMAC
  fingerprint without exposing the original value or a reusable hash.
- Print and JSON modes fail closed whenever interactive approval is required.

Run `/safe` to view session counters. Git-package installs can run
`/safe-update-check` to compare the installed checkout with `origin/main`
without changing package state.

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

`balanced` gates operations based on their resolved risk. `strict` additionally
requires approval for ordinary write/edit and mutating Bash calls, and rejects
raw project deletion in favor of `safe_delete`.

## Security boundary

The extension runs inside Pi and is not an OS sandbox. It sanitizes Bash
streaming updates, final tool results, context, and provider payloads. When the
built-in Bash output is truncated, Pi's local temporary full-output file may
still contain the original bytes; that file is not sent to the model, but disk
encryption and host access remain outside this extension's boundary.

Secret detection is deterministic and local; it never sends raw data to
another model or network service.
