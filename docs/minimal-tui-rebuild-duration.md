# pi-minimal-tui — rebuild duration reconstruction

Status: applied (iteration 1). Tracks the design and fix for the "Thought for …"
line disappearing after reload.

## Problem

`ActionGroupCoordinator` (in `packages/pi-minimal-tui/src/grouping.ts`) holds all
merge state in memory: `sequence`, `actions`, `views`, `agentStartedAt`. The
`• Thought for 20s` line is driven by `GroupView.elapsedMs`, which is only ever
produced by `finishAgent()` on the live `agent_end` event.

On reload / resume / post-compaction rebuild, `index.ts` calls
`grouping.rebuild(context.sessionManager.getBranch())` from the `session_start`
handler. The old `rebuild()`:

1. called `reset()` — wiping `agentStartedAt`, `sequence`, `views`;
2. replayed `recordMessage()` over entries — reconstructing tool actions and
   boundaries, but with **no `elapsedMs`** on any boundary;
3. never called `startAgent()` / `finishAgent()`, so `elapsedMs` was never
   reattached.

Result: every `GroupView.elapsedMs` was `undefined` after rebuild, and
`MinimalToolCallComponent.render` drops the line when `elapsedMs` is undefined
(`groupView?.elapsedMs === undefined ? [] : [Thought line]`). The grouped
summary line (`Read N files, searched M times`) survived because it is derived
from tool names, which rebuild reconstructs. The `marker: "last"` styling also
collapsed, since it is set together with `elapsedMs` in `flushFinal`.

The `tests/grouping.test.ts` rebuild cases only asserted on `summary`/`hidden`,
never on `elapsedMs` — so the gap was unguarded.

## Evidence that the data is persisted

`SessionEntryBase.timestamp` is a persisted ISO string on every
`SessionEntry` (`new Date().toISOString()` at write time — see
`@earendil-works/pi-coding-agent` `dist/core/session-manager.js`). `getBranch()`
returns `SessionEntry[]`, each carrying `.timestamp`, `.type`, and `.message`.
Pi's own compaction code reads it the same way
(`new Date(compactionEntry.timestamp).getTime()` at `agent-session.js:1525`),
and the cache-waste module re-derives idle time from `message.timestamp` on the
rebuild path. So the witness needed to reconstruct turn duration is durable —
the minimal-tui `rebuild()` simply never read it.

## Fix

`rebuild()` now replays entries in order and reconstructs the
`agent_start → agent_end` lifecycle from `entry.timestamp`:

- A `user` message starts a run → `startAgent(entryMs)` (≈ agent_start).
- The next `user` message, a `compaction`, or a `branch_summary` entry closes
  the run → `finishAgent(prevMs)`, where `prevMs` is the previous entry's
  timestamp (the closest available witness to the live `agent_end` moment).
- The end of the branch closes any still-open run the same way.
- `finishAgent` attaches `elapsedMs` to the last boundary in the sequence, and
  `recompute()` propagates it onto the turn's final tool-group view — mirroring
  the live path exactly. No change to `startAgent`/`finishAgent`/`recompute` or
  to `render.ts`.

A `parseTimestamp` helper parses the ISO string to ms via
`new Date(value).getTime()` (returns `undefined` for missing / non-finite
values, so entries without timestamps degrade gracefully — matching the previous
no-duration behavior rather than crashing).

## Tests added (`tests/grouping.test.ts`)

- `session replay reconstructs thought duration from entry timestamps` — a
  single turn (user → two grouped tools → final text) asserts `elapsedMs`,
  `marker: "last"`, and the grouped summary all survive rebuild.
- `session replay closes each turn at the next user message` — two consecutive
  turns assert each gets its own duration (30s, 20s) and they do not bleed.

Existing rebuild tests (no timestamps) are unchanged: with no timestamp,
`startAgent` is never called and behavior matches the previous no-duration path,
so their `deepEqual` assertions still hold.

## Deliberate boundary / limitation

A turn that begins at a compaction boundary with **no preceding user message in
the branch** (e.g. resuming straight into a compacted history) cannot be
anchored to a user-message timestamp, so it is left without a duration. This
keeps the semantics clean (turn start = user message, matching the live
`agent_start` trigger) at the cost of missing the first post-compaction turn's
label. Covering it by falling back to the first assistant message's timestamp
would under-count duration (that timestamp includes generation time) and is left
as a follow-up if it turns out to matter in practice.

`Thought for …` still measures the public `agent_start → agent_end` lifecycle
(elapsed agent-run time, including tool execution), not a model-reported private
thinking duration. The reconstruction approximates that lifecycle from
persisted entry timestamps; live runs continue to use the exact `Date.now()`
samples from the `agent_start` / `agent_end` events.
