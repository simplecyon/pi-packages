# @simplecyon/pi-skill-telemetry

Privacy-preserving local skill usage telemetry for Pi.

The extension records explicit `/skill:name` expansion and model-driven reads
of registered `SKILL.md` files. It never stores prompts, skill contents, tool
outputs, shell commands, or absolute paths.

## Behavior

- Confirms explicit and model-driven skill invocations.
- Appends a compact durable conversation event:
  `✦ 使用了 <skill-name> 技能`.
- Keeps that event visible in the session while excluding it from model
  context.
- Gives each Pi process an independent open spool.
- Seals completed spools into immutable, checksummed JSONL segments after a
  skill-bearing run settles.
- Keeps a stable local installation identity for later private aggregation.

## Storage

The default local directory is:

```text
~/.pi/agent/skill-telemetry/
```

Override it for testing or isolated environments:

```bash
PI_SKILL_TELEMETRY_DIR=/absolute/path pi
```

Sealed segments can be published by a separate private synchronization
workflow. This package does not send telemetry over the network itself.

## Install

Install only this package:

```bash
pi install npm:@simplecyon/pi-skill-telemetry
```

For a trusted project-local installation:

```bash
pi install npm:@simplecyon/pi-skill-telemetry -l --approve
```

For local development:

```bash
pi install -l --approve /absolute/path/to/pi-packages/packages/pi-skill-telemetry
```

The complete suite remains available as
`git:github.com/simplecyon/pi-packages`.

## Command

```text
/skill-stats
```

The command displays a compact summary for the current device.

## Privacy boundary

Stored records identify the skill and local invocation metadata needed for
aggregation. They exclude user content, model content, file contents, commands,
tool results, and direct absolute paths.

## Compatibility

Targets Pi 0.82.x. Local segment creation works without `agent-sync`; publishing
or cross-device aggregation is intentionally outside this package.

## Development

From the monorepo root:

```bash
pnpm --filter @simplecyon/pi-skill-telemetry check
```

See the [repository README](../../README.md) for suite installation and
workspace conventions.
