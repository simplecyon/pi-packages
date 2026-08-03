# pi-safe-operation interaction-mode audit

Date: 2026-08-03
Scope: `packages/pi-safe-operation` interaction modes (`chat`, `plan`, `accept-edits`, `auto`)
Revalidated source: `039e558` (`feat(pi-safe-operation): add interaction modes`)

## Outcome

The interaction-mode update resolves two original blockers:

- runtime switching to `plan` now calls `enterPlanning()` immediately, and leaving plan calls `exitPlanning()`;
- the package test suite isolates its global config and treats unavailable Windows symlink capability as an explicit skip.

`npm run check` now passes: 46 tests pass and 2 symlink-capability tests skip. The remaining work is still material: plan mode can restore files, plan todos overwrite unrelated session tasks, and auto mode now sends every ordinary mutation to the judge by default.

The Vault-installed Git package remains behind this source checkout (`d1f7ae4` vs `039e558`) and does not contain the interaction-mode implementation. Do not treat the Vault runtime as validating this feature until it is updated after the remaining repair set lands.

## Compatibility repair — 2026-08-03

Observed in the Vault runtime: the explicit `openai-codex/gpt-5.4-mini` judge rejected the request field `temperature` with `Unsupported parameter: temperature`; fail-closed behavior correctly blocked the operation, but made the judge path self-locking.

Repair: remove the hard-coded `temperature: 0` from `src/judge.ts`. `completeSimple()` now omits the field unless a caller deliberately supplies one. The auto-allow regression fixture asserts that the judge completion options have no `temperature` value.

Release gate: run the package check, then refresh the Vault Git package and use a non-sensitive Auto-mode edit as a smoke test before relying on judge-mediated writes.

## Resolved since the previous audit

| Previous finding | Current evidence | Status |
| --- | --- | --- |
| Runtime switch to `plan` did not enter planning state | `applyInteractionMode()` calls `planMode.enterPlanning(ctx)`; a dedicated `/mode plan` test verifies write tools are immediately disabled. | Resolved |
| Tests read the developer's ambient global config | Full `npm run check` now passes under the present global configuration. | Resolved |
| Windows symlink tests caused the whole check to fail | The two tests explicitly skip when symlink creation is unavailable. | Resolved with capability-based coverage |

## Repair plan

### Batch 1 — restore plan-mode integrity

| Finding | Current evidence | Required change | Acceptance evidence |
| --- | --- | --- | --- |
| Plan mode permits `safe_restore` mutations | `src/permission-mode.ts` disables only `edit`, `write`, and `safe_delete`; the `tool_call` planning gate in `src/index.ts` has the same list. `safe_restore` still moves files and rewrites its manifest. | Define package-owned mutating tools once and deny all of them while `isPlanningPhase()`. | A planning-phase `safe_restore` call is blocked before confirmation or filesystem mutation. |
| Plan todos replace unrelated task state | `permission-mode.ts` emits a full `simplecyon:session-tasks:sync` snapshot; `pi-session-tasks/src/index.ts` replaces `currentSnapshot` on that event. | Use a plan-owned widget/namespace, or add ownership and revision-aware merging to the task protocol. | Existing user tasks survive entering, executing, and completing a plan. |
| Plan tool restoration can erase tools added by another extension | `restoreNormalModeTools()` restores a pre-plan full `activeTools` snapshot. | Manage only this extension's additions/removals, preserving the live set owned by other extensions. | A tool enabled by another extension during planning remains enabled after exit. |

### Batch 2 — decide and enforce the actual auto boundary

| Finding | Current evidence | Required change | Acceptance evidence |
| --- | --- | --- | --- |
| `auto` can allow protected-path writes | Protected-path matches remain normal adjudication reasons in `src/index.ts`; a judge `allow` returns success in `src/judge.ts`. | Make a policy decision before more implementation. Recommended: hard-block `.git` and safety policy/config paths before the judge; explicitly list any lower-risk protected paths that remain adjudicable. | A fake judge returning `allow` is never called for every immutable protected class. |
| `strict` misses arbitrary Bash mutation | `looksLikeMutatingBash()` remains a small regex set; interpreter operations such as `node -e` do not match it. | In strict mode, gate every Bash command except an explicit read-only allowlist. | Tests cover Node/Python mutations, redirection, and allowed read-only commands. |
| Auto egress is broader than the prior plan assumed | `DEFAULT_JUDGE_CONFIG.auditSafeOps` is now `true`; README confirms ordinary mutations are sent to the judge. Project config may also enable it. | Treat this as an explicit egress policy: user-owned opt-in, per-session disclosure, or a documented default with a minimized payload. A trusted project alone should not broaden egress. | A project config cannot make a user-disabled safe-mutation payload leave the process. |
| Judge payload redaction/minimization remains incomplete | `judgeRequestFromEvent()` passes `path` and `targets` without redaction and sends edit/write text up to 12k characters. | Redact every payload field and default to bounded summaries/hashes; full content needs explicit user-owned opt-in. | Fake judge payloads contain no secrets in paths, targets, old/new text, or write content. |

### Batch 3 — compatibility and runtime resilience

| Finding | Current evidence | Required change | Acceptance evidence |
| --- | --- | --- | --- |
| Legacy command is not fully compatible | Config `permissionMode: ask` maps to `accept-edits`, but `/permission-mode ask` now routes to `/mode` validation and rejects `ask`. | Either retain `ask` translation on the legacy command or remove the alias with a migration notice. | `/permission-mode ask`, `plan`, and `auto` all behave as documented during the migration period. |
| Cancelled work does not cancel the judge request | Judge completion still only receives `AbortSignal.timeout(...)`, not the host operation signal. | Combine host cancellation and timeout; cancellation must be fail closed. | Aborting the source tool call aborts completion and cannot later allow the operation. |
| Malformed config or persisted plan state can crash startup | `mergeConfig()` still spreads unvalidated arrays; session state is restored through unchecked casts. | Validate/coerce config and persisted shapes, reject bad fields, retain conservative defaults. | Object/null/non-array config and corrupt entries safely start with a warning or block. |
| Plan approval persists its execution mode globally | Selecting auto/accept-edits calls the global interaction-mode setter. | Make the approval choice execution-scoped, or explicitly disclose persistence and abort execution if persistence fails. | A plan's execution choice does not silently change future sessions. |
| Plan guidance references `questionnaire` | The planning tool list and injected instruction still use `questionnaire`, while the available structured tool is `AskUserQuestion`. | Use the actual tool name only if available, otherwise omit it. | Plan-mode tool list contains no unavailable tools. |

## Test and release gates

1. Add regression tests for every remaining Batch 1 and 3 finding; add an integration test spanning `pi-safe-operation` and `pi-session-tasks`.
2. Create an operation-policy matrix: operation class × interaction mode × UI/headless × trusted/untrusted project. Generate the core behavior tests from it.
3. Add a shadow rollout for auto: record judge verdicts and deterministic reasons before widening auto-allow scope.
4. Run package `npm run check`, workspace checks, and a real trusted-project Pi smoke test for all four interaction modes.
5. Update README and design docs to distinguish immutable hard blocks, human-confirmed operations, and judge-adjudicable operations.
6. Only then update the Vault package checkout and run its loader regression test.

## Observed validation

```text
npm run check
46 pass, 0 fail, 2 skipped
```

The two skipped tests require Windows Developer Mode or elevated permissions to create symlinks. They remain necessary coverage in a capability-enabled CI environment.
