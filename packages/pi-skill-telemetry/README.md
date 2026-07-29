# @cyon/pi-skill-telemetry

Privacy-preserving skill usage telemetry for Pi. The extension records explicit
`/skill:name` expansion and model-driven `read` calls for registered `SKILL.md`
files. It never stores prompts, skill content, tool output, shell commands, or
absolute paths.

Each confirmed invocation also appends a compact, durable TUI event:
`✦ 使用了 <skill-name> 技能`. The event is visible in the conversation stream
and persists with the session, but is excluded from LLM context.

Events are written to:

```text
~/.pi/agent/skill-telemetry/
```

Each Pi process owns a separate open spool. After a skill-bearing agent run
settles, the spool is sealed into an immutable, checksummed JSONL segment.
`agent-sync telemetry publish` copies sealed segments into the private Hub under
the current device namespace, where any device can aggregate them.

For the Cyon vault, the synchronized project-level deployment is:

```text
<vault>/.pi/extensions/skill-telemetry/
```

The local/private package remains the development and packaging source.

## Commands

- `/skill-stats` shows a compact local-device summary inside Pi.
- `PI_SKILL_TELEMETRY_DIR=/path` overrides storage for testing.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```
