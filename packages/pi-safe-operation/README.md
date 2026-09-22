# @simplecyon/pi-safe-operation

Operation safety and secret-egress guardrails for
[Pi](https://github.com/earendil-works/pi).

When this package owns the standalone built-in Bash registration, missing
timeouts default to 30 seconds. Explicit timeout values are preserved and use
Pi's seconds unit.

Interactive write/edit and dangerous-Bash confirmations emit metadata-only
approval durations on the Pi event bus. `pi-tool-runtime` uses this to keep
human approval time separate from command execution time.

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
- Approval dialogs lead with a plain-language action summary, the condition
  under which approval is worthwhile, concrete risks, affected targets, and a
  safer alternative. The complete command remains last as technical detail
  instead of acting as the risk explanation.
- Safety decisions constrain the intended effect, not merely one tool call.
  Agent guidance prohibits retrying, translating, decomposing, delegating, or
  recommending a substantially equivalent operation after it is blocked or
  declined. A new action may proceed only when it materially narrows the scope
  or removes the stated risk. A fresh explicit authorization may resume an
  approval-gated action after the user declined it, but cannot override a policy
  block.
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

## Interaction modes

Set the user-level `interactionMode` in `~/.pi/agent/safe-operation.json`, or
switch it at runtime with `/mode` (the legacy `/permission-mode` remains an
alias). The default is `accept-edits`, preserving the former default behavior.

- `chat` — conversation plus read-only inspection: `read`, `grep`, `find`,
  `ls`, the read-only search tools, and read-only Bash commands stay
  available; mutating tools and non-allowlisted Bash are blocked.
- `plan` — read-only exploration and a numbered plan. Approval chooses whether
  to execute in `accept-edits` or `auto`.
- `accept-edits` — ordinary edits run; deterministic flagged operations ask the
  user for confirmation.
- `auto` — the Agent continues autonomously. The judge reviews mutation
  operations from redacted facts: `allow` executes; `adjust` or `escalate`
  blocks the current operation and returns actionable constraints to the main
  Agent, which must re-plan rather than turn technical risk into a user popup.
  `need_evidence` requests fixed read-only probes (`file_state`, `git_status`,
  `current_content`), with at most two evidence rounds under one judge deadline.
  Repeated requests with no new facts stop immediately. `deny` is a policy rejection;
  `unavailable` is a service or response-protocol failure, not a safety verdict.

```json
{
  "interactionMode": "auto",
  "judge": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "maxTokens": 1024,
    "timeoutMs": 20000,
    "reasoning": "low"
  }
}
```

In auto mode, the Agent stops only after verified completion, when no
policy-compliant path remains, or when the user must supply a preference,
authorization, or missing information. Technical uncertainty should trigger
inspection, testing, or a safer alternative instead. `judge.auditSafeOps`
defaults to `true`, so ordinary mutations are also reviewed; deterministic
hard blocks never reach the model. Auto-mode writes always enter review, even
when `auditSafeOps` is false; that option cannot bypass overwrite evidence checks. Legacy `permissionMode: "ask" | "plan" |
"auto"` is read for compatibility (`ask` maps to `accept-edits`) but is no
longer written.

## Auto review evidence and recovery

The judge receives redacted policy context, explicit target metadata, the proposed
change, and up to three recent user-message excerpts from the active session branch.
Excerpts are incomplete source evidence, not new authorization. Missing context
must not be interpreted as approval. Paths, reasons and target lists are redacted
along with content. Evidence probes cannot run model-supplied commands or read
model-selected paths. Existing content is collected automatically before reviewing a full overwrite of an
existing file, and on request for other operations, from non-sensitive,
non-protected regular files, with a total 16 KB read budget per review. Binary files
and symlink leaves are not read. Truncation and unavailable facts remain explicit.
Git status is an observation, not proof of recoverability.

Full overwrites require complete original text and proposed content on the first
judge request. If the original cannot be read, is binary, a symlink, sensitive,
or exceeds the 16 KB read budget, or the proposed redacted content exceeds the
12,000-character change budget, the operation is blocked locally without calling
the model. Use a bounded targeted edit instead. This also applies to explicitly
authorized full replacements: the current review path requires a complete
comparison. An observed missing file remains a creation. The judge must compare
all changes against the user request; providing evidence does not itself prove
that a model will correctly assess authorization. Original content replaced by
a secret-density redaction summary is unavailable evidence, not complete text.
Reviewed write/edit proposals also fail closed locally when any proposed change
is truncated or replaced by such a summary. Edit blocks are redacted before JSON
encoding so exact string/newline boundaries and credential detection are preserved.
File-supplied angle brackets are escaped inside the JSON audit envelope. Verdict
parsing remains strict; empty or unrelated optional fields are not silently accepted.

Only `allow` with `none` or `low` risk can execute. Missing/invalid fields,
contradictory verdicts and unsupported probe names fail closed as `unavailable`.
Auto mode blocks recognized protected-path mutations before calling the judge;
`accept-edits` retains its interactive behavior. Explicit target metadata is checked
again after approval; a changed target requires fresh review. This narrows the race
window but is not an atomic filesystem transaction or coverage of arbitrary Bash
side effects.

Session-local blocked-review fingerprints suppress identical submissions while
observed target state, operation, user-message excerpts, policy and judge settings
are unchanged. Approvals and service failures are never cached. This is duplicate
suppression, not a semantic equivalent-action detector. The non-circumvention rule
still applies to safety refusals. After a service failure, restore the service and
resubmit for review; do not change tools to bypass it. Existing `onFailure` values
remain readable for compatibility; neither opens a technical approval popup.

## Live acceptance

The opt-in `scripts/judge-live.mjs` runner uses synthetic temporary Git projects,
real extension gates and real provider requests; it is not part of `npm test`.
It never executes negative proposals. Each repetition creates a new session to
avoid cached blocks. Host credentials stay in memory and the runner uses an
isolated HOME/config without modifying the user's judge selection.

```bash
PI_LIVE_HOST_PACKAGE=/absolute/path/to/pi-coding-agent \
  node scripts/judge-live.mjs --model wenge-main/deepreasoning-ds-v4flash \
  --out /tmp/new-unique-judge-run --repeats 3
```

The output directory must not already exist. Raw calls, verdicts, file hashes,
latency, source hashes and summaries are retained; treat failed expectations as
an acceptance failure. See [the repeated live evaluation](docs/judge-live-2026-09-21.md)
for measured results and limitations.

## Security boundary

The extension runs inside Pi and is not an OS sandbox. It sanitizes Bash
streaming updates, final tool results, context, and provider payloads. When the
built-in Bash output is truncated, Pi's local temporary full-output file may
still contain the original bytes; that file is not sent to the model, but disk
encryption and host access remain outside this extension's boundary.

Secret detection is deterministic and local; it never sends raw data to
another model or network service.
