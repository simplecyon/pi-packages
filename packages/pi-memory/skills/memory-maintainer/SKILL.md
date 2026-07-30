---
name: memory-maintainer
description: Safely create, update, consolidate, move, or delete scoped project memory in MEMORY.md and .memory Markdown files. Mandatory when the user explicitly asks to remember, persist, update, consolidate, migrate, move, delete, clean up, or otherwise maintain project memory; also use before modifying an existing project-memory index or topic file. Do not trigger merely because information seems useful.
---

# Memory Maintainer

Maintain durable project context without producing duplicate rules, unindexed
topic files, or unreviewed destructive changes.

## Workflow

1. Read the nearest applicable `AGENTS.md` and `MEMORY.md`. If they route to a
   memory protocol, read it completely before editing.
2. Inspect repository status and preserve unrelated work. Follow any scoped
   fetch, rebase, staging, or commit gates.
3. Confirm that the user authorized memory maintenance. A request such as
   "remember this" authorizes a scoped create, additive update, and surgical
   correction of a status or routing sentence directly falsified by that
   authorized change. Do not infer write authorization from information merely
   appearing durable.
4. Search existing coverage with `memory_search` when available, then use
   repository search for exact wording, related concepts, target paths, and
   index entries.
5. Classify the proposed operation as `CREATE`, `UPDATE`, `COPY`, `MOVE`, or
   `DELETE`. Present the classification plan before changing files when it
   includes overwrite, replacement, MOVE, DELETE, broad de-duplication, or an
   ambiguous target.
6. Apply the smallest coherent edit with normal read/edit/write tools. Do not
   bypass project safety extensions or use a special privileged writer.
7. Verify content coverage, index integrity, scoped diffs, and any repository
   checks required by local instructions.

## Placement

- Put stable rules, startup order, scope boundaries, frequent recovery paths,
  behavior-changing preferences, and routing entries in the deepest owning
  `MEMORY.md`.
- Put longer evidence, raw failure chains, timelines, commands, and low-frequency
  expensive rediscovery in the owning scope's `.memory/<topic>.md`.
- Prefer the deepest scope that fully owns the fact. Avoid copying domain facts
  into a root or global memory.
- Create topic files lazily. Never pre-scaffold empty memory directories or
  placeholder files.

Every `.memory/<topic>.md` must have an entry in the nearest owning `MEMORY.md`
with:

```md
- <topic>: see `.memory/<topic>.md`
  - triggers: <specific words, symptoms, paths, or error strings>
  - use when: <the situation where recall pays off>
```

Write triggers in the terminology users actually use. Include both Chinese and
English forms when both commonly appear, but avoid synonym dumps.

## Content test

Keep only context that is stable, reusable, and likely to prevent future broad
rediscovery or a repeated mistake.

Exclude:

- one-off run logs, transcripts, token or cost traces;
- secrets, credentials, direct personal identifiers, or sensitive payloads;
- rules already owned by `AGENTS.md`;
- device paths already owned by a device registry;
- human-facing durable knowledge that belongs in a normal project document.

Merge overlapping material into the existing owner instead of appending another
near-duplicate. If a newer fact conflicts with current memory, preserve the
conflict explicitly until evidence establishes which statement should replace
the other.

## Destructive boundary

Require explicit user confirmation immediately before:

- deleting a memory file or index entry;
- overwriting a whole memory file or replacing established facts beyond the
  directly authorized update;
- moving memory between scopes when the source will be removed;
- applying broad memory cleanup or de-duplication.

For `MOVE`, first write the destination, verify equivalent semantic coverage,
update its index, and only then ask to remove the source. Never treat a matching
filename as proof of equivalent coverage.

Do not preserve a now-false inventory statement merely to avoid a surgical
edit. When the authorized operation itself proves a statement such as "no
memory exists" false, correct that statement in the same change. Preserve both
claims only when the underlying evidence remains genuinely uncertain.

## Done check

Before reporting completion, confirm:

- the target scope is correct;
- no unrelated changes were modified;
- the topic is not duplicated elsewhere;
- every topic file has exactly one usable nearest-scope index entry;
- `triggers` and `use when` describe reliable recall conditions;
- no empty topic files or broken `.memory/` paths were introduced;
- deletions or replacements have recorded user authorization.
