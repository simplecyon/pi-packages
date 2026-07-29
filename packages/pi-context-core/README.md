# @simplecyon/pi-context-core

Shared, model-invisible primitives for measuring token and context economics in
Pi extensions.

This is a library package, not an extension. Importing it does not register
tools, commands, hooks, or prompt text.

```ts
import {
  TOKEN_ROI_MILESTONE_EVENT,
  TokenRoiTracker,
} from "@simplecyon/pi-context-core";

const tracker = new TokenRoiTracker();
tracker.recordToolCall();
tracker.recordToolResult([{ type: "text", text: "result" }], false);

pi.events.emit(TOKEN_ROI_MILESTONE_EVENT, {
  kind: "task_completed",
});
```

The package currently provides mixed CJK/Latin token estimation, provider usage
aggregation, content-only result fingerprints, operation-shape attribution, a
validated low-cardinality milestone protocol, and an in-memory ROI tracker. It
never persists tool arguments or result contents.
