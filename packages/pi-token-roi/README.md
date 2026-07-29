# @simplecyon/pi-token-roi

Observe-only Token ROI telemetry for Pi.

The extension adds no model-visible tools or prompt text. It records aggregate
provider usage, tool calls, model continuations after tool results, tool errors,
tool-result volume, duplicate result volume, verified milestones, and
privacy-safe operation shapes in memory. It can advise on continuation
overhead, duplicate results, active schema overhead, and possible
`read → write → delete` relocation sequences without changing execution.

Commands:

```text
/roi
/roi --json
/roi --json reports/my-roi.json
```

`/roi` shows a compact report. `--json` writes aggregate metrics to
`.pi/roi/roi-latest.json` by default or to the supplied path. Exported reports do
not contain prompts, tool arguments, tool-result contents, or result
fingerprints.

When another extension emits the `token-roi:verified-milestone` protocol from
`@simplecyon/pi-context-core`, reports also show economic tokens and model
requests per milestone. `pi-session-tasks` emits one
`session_task_completed` milestone for each accepted transition to completed.

The measurement window begins when the extension loads or receives
`session_start`. See [`../../docs/token-roi.md`](../../docs/token-roi.md) for the
architecture and `context-mode` migration boundary.
