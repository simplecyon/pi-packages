# @simplecyon/pi-ask-user-question

Structured human-in-the-loop questions for Pi. The extension registers the
LLM-callable `AskUserQuestion` tool with single-select, multi-select, custom
answers, previews, multi-question review, and explicit cancellation.

## Install

```bash
pi install npm:@simplecyon/pi-ask-user-question
```

The complete `simplecyon/pi-packages` Git package also includes this extension.

## Behavior

- Ask one blocking question, or batch up to four independent questions.
- Every question has 2-4 options and an automatic `Other...` answer.
- `preview` is available for single-select code, config, diagram, or ASCII comparisons.
- The tool runs sequentially so interactive dialogs cannot overlap.
- Double Escape cancels and returns control to chat without an automatic model follow-up.
- TUI mode uses the rich dialog. RPC mode uses Pi's portable select/input protocol.
- Print and JSON modes return a structured `unavailable` result.
- Compatible SimpleCyon widgets hide during the dialog through the
  `simplecyon:ui-exclusive` event and restore their own state afterwards.

The tool is for preferences and missing requirements. Dangerous-action
confirmation belongs in Pi's permission or confirmation flow.
