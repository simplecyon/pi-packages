# @cyon/pi-session-tasks

Session-scoped, branch-aware structured task tracking for Pi.

The extension gives the agent revision-safe task tools while rendering a compact
progress view for the user. Task state stays in the Pi session instead of an
external project tracker.

## Behavior

- `get_tasks` reads the current list and revision.
- `update_tasks` replaces the list only when `expected_revision` is current,
  preventing parallel or stale updates from overwriting newer state.
- Task states are `pending`, `in_progress`, and `completed`.
- Exactly one task must be `in_progress` while unfinished work remains.
- `paused` is a derived presentation state when Pi settles with unfinished
  work; it is not writable task data and does not guess why the agent stopped.
- Completed lists collapse to a summary and disappear on the next idle human
  request.
- An empty replacement clears the list.
- Session reconstruction accepts older snapshots but validates stored render
  details before using them.

Use structured tasks for work with several meaningful steps, not as overhead
for one-step edits.

## Install

Install the aggregate package:

```bash
pi install git:github.com/simplecyon/pi-packages
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages
```

## User command

```text
/tasks
```

`/tasks` displays the full current list. Updates remain agent-controlled through
the registered tools.

## Compatibility

Targets Pi 0.82.x. Task state is local to a session and follows Pi's branch and
session lifecycle; it is not synchronized across independent sessions.

## Development

From the monorepo root:

```bash
pnpm --filter @cyon/pi-session-tasks check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
