# Pi Session Tasks

A production-oriented Pi extension that gives the agent a structured `update_tasks` tool and renders task progress in the TUI.

## Behavior

- Session-scoped and branch-aware.
- Recommended for work with three or more meaningful steps.
- Task states: `pending`, `in_progress`, and `completed`.
- Exactly one task must be `in_progress` while unfinished work remains.
- The TUI derives `paused` when Pi has settled but a task is still in progress.
- Completed task lists collapse to a summary and are hidden on the next idle human request.
- Users can inspect the full list with `/tasks`; editing remains agent-only.
- Passing an empty task list clears the current list.

`paused` is a presentation state, not a value the agent can write. It does not infer why Pi stopped.

## Development

```bash
npm install
npm test
npm run typecheck
```

Load the source extension directly:

```bash
pi -e ./src/index.ts
```

## Production deployment

For a project-local installation, copy the three files under `src/` to:

```text
.pi/extensions/session-tasks/
```

Pi discovers the directory through its `index.ts`.
