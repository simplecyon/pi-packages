# @simplecyon/pi-tool-runtime

Adds two runtime-level controls to Pi without modifying Pi core:

- phase-aware session telemetry for model wait and total tool latency;
- concise tool-use guidance that limits search broadening, retries, and
  unbounded shell execution.

Use `/runtime` to inspect the current session. The report keeps model latency,
safety-approval latency, execution-like tool latency, and interactive waiting
separate. When `pi-safe-operation` is present, its confirmation time is emitted
as metadata and subtracted from the corresponding tool duration.

Telemetry is stored as metadata-only custom session entries. Tool arguments,
command text, file contents, prompts, and results are not persisted.

The package deliberately does not re-register built-in tools. The aggregate
suite's `pi-minimal-tui` package injects a 30-second default for built-in Bash,
and `pi-safe-operation` applies the same default when it owns the standalone
Bash registration.
