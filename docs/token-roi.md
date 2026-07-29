# Token ROI architecture

Status: implemented foundation, observe-only telemetry, advisor-only
attribution, dynamic schema reduction, safety-gated bounded output with durable
recovery, and project-settings migration away from `context-mode-cyon`. Human
A/B acceptance remains.

## Goal

Optimize the amount of verified work completed per token and per model
continuation. Raw context reduction is useful only when it improves end-to-end
task economics without increasing retries, lost evidence, or incorrect actions.

The primary operating unit is a **tool yield**: one model continuation after a
batch of tool results. A direct `mv` and a `read -> write -> rm` sequence are not
equivalent economically even when both ultimately move a file, because the
second path normally creates more model continuations and repeats the fixed
cached context.

## Measurement model

Token ROI has three separate layers:

1. **Economic cost** — provider-reported input, output, cache read, cache write,
   and monetary cost.
2. **Context occupancy** — current context tokens plus active tool-schema
   tokens.
3. **Useful progress** — tool calls, tool yields, errors, duplicate tool
   results, and explicit verified milestones. v1 does not invent a success
   score from proxy metrics.

The observe-only report intentionally exposes primitives instead of collapsing
them into a single misleading number.

## Package boundaries

```text
@simplecyon/pi-context-core
  token estimation, usage aggregation, result fingerprints, ROI tracker
        |
        +-- @simplecyon/pi-token-roi       longitudinal/session economics
        +-- pi-context-inspector          current context composition (future consumer)
        +-- pi-context-compact            cold-history control (future consumer)
        +-- pi-safe-operation             safety/redaction, remains independent
```

`pi-context-core` is a library, not a Pi extension. Loading it adds no prompt
text, slash command, model-visible tool, or tool schema.

`pi-token-roi` is observe-only by default:

- no prompt or system-prompt injection;
- no model-visible tools;
- no tool-result mutation;
- no tool arguments or result contents persisted;
- duplicate detection stores only SHA-256 fingerprints and sizes in memory;
- `/roi` is a user-invoked slash command and therefore does not consume a model
  turn;
- `/roi --json [path]` exports aggregate metrics only.
- advice is computed only when `/roi` runs and never changes execution.

## `context-mode` migration boundary

The external `context-mode-cyon` extension is a behavioral benchmark and
migration reference point, not a runtime or source dependency. No package in this
repository imports it, requires it to be installed, or assumes its storage
format.

Capabilities worth absorbing through independent implementation:

- bounded tool-output rendering;
- durable full-result artifacts with compact context references;
- search over those artifacts;
- duplicate-result suppression;
- dynamic activation of model-visible tools.

Migration phases:

1. **Observe** — establish baselines with `pi-token-roi`.
2. **Advise** — identify high-yield, duplicate-output, schema-overhead, and
   relocation-candidate patterns without changing execution. Implemented.
3. **Act behind explicit policy** — bounded output, artifact storage, retrieval,
   and dynamic tool loading. Implemented for large text tool results:
   `pi-context-artifacts` stores the redacted original, returns a bounded
   preview, reuses duplicate artifacts, and activates `artifact_read` only when
   recovery data exists. `compact_search` stays inactive until owned cold
   history exists.
4. **A/B acceptance** — automated replay and package gates are implemented;
   human comparison of task success, model continuations, latency, and recovery
   behavior remains.
5. **Remove external extension** — implemented in project settings after the
   automated replacement gates passed. The settings diff remains the rollback
   path until human acceptance.

Raw-byte savings alone are not an acceptance criterion.

### Bounded-output policy

Artifact creation is fail-open for task correctness and fail-closed for
persistence safety:

- without the `pi-safe-operation` redaction capability, no artifact is written;
- errors, images, and recovery-tool outputs remain unchanged;
- storage must complete before model-visible content is replaced;
- storage or preview failures preserve the original result;
- the visible budget is clamped to at most half of the smallest trigger
  threshold;
- identical redacted outputs reuse one artifact;
- exact offset recovery and bounded in-artifact search remain available.

The default hard threshold is 24k estimated tokens. Under at least 65% context
pressure, the threshold becomes 8k. The default visible budget is 3k.

## v1 metrics and definitions

- `assistantRequests`: completed assistant messages with provider usage.
- `toolCalls`: tool invocations observed.
- `toolYields`: turns that returned one or more tool results to the model.
- `toolResults`: completed tool results observed.
- `toolErrors`: failed tool results.
- `toolResultTokens`: estimated tokens returned by tools.
- `duplicateResultTokens`: estimated tokens in a non-empty result whose
  fingerprint was already observed in this measurement window.
- `verifiedMilestones`: validated low-cardinality progress events emitted by
  cooperating extensions. `pi-session-tasks` emits `session_task_completed`.
- `economicTokensPerMilestone`: provider-reported total tokens divided by
  verified milestones; `null` when the denominator is unavailable.
- `operationPatterns`: counts coarse tool-call shapes only. The tracker does not
  retain paths, commands, arguments, task IDs, or task titles.
- `artifactizedResults`, `artifactReuses`, and `artifactTokensSaved`: bounded
  output activity and estimated model-context reduction.
- `usage`: provider-reported token and cost totals.
- `activeToolSchemaTokens`: estimated model-visible schema occupancy at report
  time.
- `context`: Pi's current context usage at report time.

### Dynamic schema reduction

`pi-context-compact` registers `compact_search` but removes it from the initial
active tool set for branches with no owned compaction. After a successful
durable compaction, Pi activates it additively at the tool-result boundary.
Resumed branches reactivate it only when an owned compaction entry is present.
The tool omits active-only prompt snippets and guidelines, preserving the stable
system-prompt prefix when Pi can use provider-native deferred definitions.

`artifact_read` follows the same rule: it is inactive until the current session
has at least one durable artifact.

## Acceptance gates

Automated replay gates:

1. safe-operation redacts before artifact persistence;
2. no safety capability means no persistence;
3. the replay preview uses less than 25% of the original estimated tokens;
4. exact chunked recovery reconstructs the full stored result;
5. duplicate results reuse one durable artifact;
6. errors, images, and recovery results are never archived;
7. persistence failure leaves the original result unchanged;
8. retrieval schemas are absent until their backing data exists;
9. all aggregate and independent Pi packages load without resource errors.

Human A/B remains required before declaring model-level task equivalence because
replay tests cannot prove that a model will avoid unnecessary retrieval turns.
The final comparison should cover at least one large read, one large shell
result, one compaction/resume path, and one task using verified milestones.

The measurement window begins on extension load or `session_start`. Resume-time
historical reconstruction is deliberately deferred so the first version does
not mix inferred and directly observed events.

## Remaining human acceptance

1. Calibrate advisor confidence with live sessions.
2. Compare task success and retrieval behavior on the migrated project
   configuration.
3. Consider other specialist tools for dynamic activation only when live
   measurements show a net schema win after loader overhead.

### Manual checklist

After restarting Pi in the vault:

1. Run `/artifacts`. Expect `enabled`, zero session artifacts, and an inactive
   retrieval tool in a fresh session.
2. Run `/roi` once to capture the starting context and active-schema baseline.
3. Ask the agent to execute this read-only Bash fixture and not retrieve the
   artifact yet:

   ```text
   node -e 'process.stdout.write("BEGIN-MANUAL-ROI\n" + "manual-roi-line\n".repeat(8000) + "END-MANUAL-ROI\n")'
   ```

4. Confirm the result is a bounded preview with an `art_...` ID. `/artifacts`
   should report one artifact and an active retrieval tool; `/roi` should report
   positive artifact token savings.
5. Ask the agent to use `artifact_read` to search that artifact for
   `END-MANUAL-ROI`. Confirm it recovers the tail marker.
6. Repeat the same Bash fixture. Confirm the session artifact count stays at one
   and `/roi` reports a duplicate artifact reuse.
7. Complete at least one structured session task. Confirm `/roi` reports a
   verified milestone and non-null tokens per milestone.
8. Run `/compact`, then verify `compact_search` becomes available and can recover
   an exact earlier phrase.
9. Export `/roi --json .pi/roi/manual-acceptance.json` and inspect model
   requests, tool yields, artifact savings, retrieval turns, and errors before
   accepting the migrated configuration.
