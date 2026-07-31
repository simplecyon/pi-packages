# pi-minimal-tui — standalone Thought-for entry for no-tool turns

Status: applied (iteration 2). Extends iteration 1 (rebuild duration
reconstruction) to turns that currently get no "Thought for …" line at all.

## Problem

`• Thought for …` renders only when an `agent_end` boundary with `elapsedMs`
flushes a non-empty groupable-tool group (see `render.ts` and the iteration-1
note in `docs/minimal-tui-rebuild-duration.md`). A turn that calls **no tools**
(pure thinking + text answer) has no `MinimalToolCallComponent` to host the
label, so the duration — though computed by `finishAgent` and reconstructed on
reload by `rebuild` — has nowhere to render and is invisible. (A turn ending in
a non-groupable `edit`/`write` has the same gap, because the tool flushes its
preceding group without `elapsedMs`; left out of scope here.)

## Why not `sendMessage` / `CustomMessage`

`@earendil-works/pi-coding-agent` `convertToLlm` always converts every
`CustomMessage` into a user-role context message (it ignores the `display`
field for context purposes). Injecting "Thought for 20s" via `sendMessage` would
therefore send the label to the model as a user message on every no-tool turn —
polluting context and wasting tokens. So `CustomMessage` is the wrong mechanism
for a pure UI marker.

## Fix — non-context `CustomEntry`

The package uses the `CustomEntry` path, which the type docs state explicitly
"does not participate in LLM context" (verified: `sessionEntryToContextMessages`
maps `custom_message` entries into context but leaves `custom` entries out, and
`convertToLlm`'s default case returns `undefined`).

- `grouping.ts` `ActionGroupCoordinator` now tracks per-turn tool usage:
  `turnHadTool` (reset on `startAgent`, set on `recordTool`) and exposes
  `getLastTurn(): { elapsedMs; hadTool } | undefined`, set by `finishAgent`.
- `index.ts` registers an `EntryRenderer` for
  `simplecyon/pi-minimal-tui/thought` that reads `entry.data.elapsedMs` and
  returns a `ThoughtLineComponent` (new in `render.ts`, mirroring the existing
  `• Thought for …` rendering at `render.ts`).
- On `agent_end`, after `finishAgent`, if `getLastTurn()` reports a no-tool turn
  with a finite `elapsedMs`, the extension calls
  `pi.appendEntry(THOUGHT_ENTRY_TYPE, { elapsedMs })`. `appendCustomEntry`
  appends the entry as a child of the current leaf (the final assistant message)
  and advances the leaf, so the line renders after the answer.

Persistence: the `CustomEntry` is part of the session, so it survives reload on
its own — the `EntryRenderer` re-renders it from `entry.data` without needing
the coordinator's timestamp reconstruction. The coordinator's `rebuild` ignores
`custom` entries (they have no `message`), so there is no double counting and no
double rendering (the coordinator's reconstructed `elapsedMs` for a no-tool turn
lands on a boundary with no tool group and is not rendered).

## Tests added (`tests/grouping.test.ts`)

- `getLastTurn reports a no-tool turn as unhosted with elapsed time` — a
  thinking + text-answer turn returns `{ elapsedMs, hadTool: false }`.
- `getLastTurn flags turns that called tools` — a turn with a tool call returns
  `hadTool: true`.

The `EntryRenderer` / `appendEntry` integration is runtime-only (needs a live pi
session) and is not unit-tested here; the coordinator logic that gates the
append is covered by the two tests above.

## Known limitation

Turns ending in a non-groupable tool (`edit`/`write`) still render no duration:
the tool flushes its preceding group without `elapsedMs`, and because
`turnHadTool` is true the standalone entry is not appended either. Closing that
gap would require detecting "no tool view received `elapsedMs` this turn" rather
than the simpler `!turnHadTool` check; deferred.

## Verification not run

- `tsc` / `pnpm typecheck` was not available in this environment; the
  `index.ts` `EntryRenderer` / `appendEntry` calls are typed against
  `ExtensionAPI` (`registerEntryRenderer`, `appendEntry`) and `CustomEntry`
  (`entry.data?: T`) per the installed `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` `.d.ts`. Runtime smoke test against a live pi session
  is the remaining validation.
