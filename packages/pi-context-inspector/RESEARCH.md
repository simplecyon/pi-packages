# pi-context-inspector — 最佳实践调研

> 结论先行：**v1 直接复用 pi 内部导出的 `estimateTokens` / `calculateContextTokens`（chars/4 + 真值锚定），不引 tiktoken**。per-类目分布用估算算相对占比，总量用 provider usage 校准归一。这既零新依赖，又与 pi footer 的数字保持一致。

调研方法：以**验证 pi dist 源码**为主（`node_modules/@earendil-works/pi-coding-agent/dist/`），辅以成熟工具公开做法对照。以下标注 `[已验证]` 的是从源码读到的，`[通用]` 的是外部工具的公开模式。

---

## A. pi 自己怎么算 context —— 直接可抄 `[已验证]`

来源：`dist/core/compaction/compaction.js`、`dist/core/agent-session.js`

1. **没有本地 tokenizer**。pi 用 `Math.ceil(chars / 4)` 估算，注释自称"conservative (overestimates)"。图片按**固定 4800 chars** 计。
2. **它已经是"真值锚定 + 尾部估算"混合**（`estimateContextTokens`）：
   - 找最后一条有效 assistant 的 `usage` → `calculateContextTokens(usage)` 当作那一刻的真实 context 总量
   - 该消息**之后**的新消息用 `estimateTokens`（chars/4）逐条估
   - `tokens = usageTokens + trailingTokens`
   - → 这正是 REQUIREMENTS §4 设计的方案，pi 已内建，只是它**只对整体算，不拆类目**
3. `calculateContextTokens(usage)` = `usage.totalTokens || input+output+cacheRead+cacheWrite`
   - ⚠️ 含 output。严格说"当前 context 占用"应看 `input + cacheRead`；footer 用 totalTokens 是够用近似。**本工具展示"context 占用"时倾向用 `input + cacheRead`，需在实现时二选一并注明。**
4. **压缩后有 null 守卫** `[重要坑]`：`getContextUsage()` 检测到最近一次 compaction 之后**还没有** assistant 回复时，直接返回 `tokens: null`——因为此时最后的 usage 反映的是**压缩前**的大小，不可信。**本工具必须复刻这个守卫**，否则 `/compact` 刚跑完就会显示错误数字。
5. **可复用的导出**（从 `@earendil-works/pi-coding-agent` 顶层导出，`dist/index.js` 确认）：
   `estimateTokens` · `calculateContextTokens` · `getLastAssistantUsage` · `serializeConversation`
   → **直接 import 复用**，别重造；和 pi footer 数字一致本身是特性。

---

## B. 真正的 gap = 按类目归因（pi 做不到的）

pi 的 usage 把 system + tools + skills 全**烘进** assistant `usage.input` 基线里，无法拆开。
本工具的独有价值 = 用 `ctx.getSystemPromptOptions()` 拿到**原料**（system / activeTools / toolSnippets / contextFiles / loadedSkills），对每块单独跑 chars/4，得到 pi 给不出的**类目分布**。

**关键校准细节**：各类目 chars/4 之和 ≠ 真实 `usage.input`（真 tokenizer + provider 端 prompt 格式化有差异）。所以：
- 分布：算每类的 chars/4 → 得**相对占比**
- 总量：用真值 usage 基线
- **归一**：各类目按 `真值总量 / 估算总量` 缩放，使之和对齐真值 → 显示"约 X / Y%"
- 归一分母**仅在有"压缩后 assistant usage"时有效**；否则退化为纯估算并标注"未校准"

---

## C. Tokenizer 选型（解决 REQUIREMENTS §8 两个开放问题）

| 方案 | 精度 | 依赖 | CJK | 结论 |
|------|------|------|-----|------|
| 1. 复用 pi `estimateTokens`(chars/4)+归一 | 中 | **0** | chars/4 对中文偏**低估*** | **v1 采用** |
| 2. CJK-aware 估算（中文字≈0.6/字，拉丁≈0.25/字） | 中高(相对) | 0 | 好 | v2 可选优化 |
| 3. tiktoken / js-tiktoken | 对 GPT 系准 | +wasm/体积 | 仍非 wenge 真 tokenizer | **不用**，ROI 低 |

\* 注意：pi 说 chars/4 对英文"overestimate"，但**中文 BPE 常 1 字≈1~2 token，chars/4 反而低估**。本 vault 中英混排，会**系统性压低中文类目（如 AGENTS.md、中文对话）的占比**。
- v1 因为最终归一到真值总量，**总量不受影响**；受影响的是**类目间相对比例**（中文块偏小）。可接受，但建议：
- **决策建议**：v1 用方案 1 跑通；同时做一次轻量校准——见 §F 实测脚本——若中文占比失真明显，v2 升级到方案 2 的 CJK 加权。**首版不引 tiktoken，也不必先写复杂校准脚本**，用真值归一兜底即可。

---

## D. 成熟工具的对照模式 `[通用]`

- **Claude Code `/context`**：可视化网格，分 System prompt / System tools / MCP tools / Memory files(CLAUDE.md) / Messages / Free space，显示占窗口 %。→ 与本工具"类目 + 窗口条"设计**同构**，验证方向对。
- **aider `/tokens`**：分 system messages / chat history / repo map / files，逐桶列 token 数。→ 验证"按来源拆桶"。
- **Cursor**：只显示窗口填充 %，粒度粗。

三者共性，正好是本工具 §5 布局：①窗口填充% ②把"固定开销"（system/tools/memory）与"对话"分开 ③点名最大消费者。**设计与业界先例一致，无需推翻。**

---

## E. 弹窗 TUI 实现 `[已验证]`

来源：`examples/extensions/overlay-test.ts`、`custom-footer.ts`；参考 `plan-mode/`、`modal-editor.ts`、`doom-overlay/`

- 弹窗 API：`await ctx.ui.custom(factory, { overlay: true })`
  - `factory = (tui, theme, keybindings, done) => FocusableComponent`
  - 返回 Promise，resolve 成组件 `done(result)` 的值
- 组件实现 `Focusable`：`handleInput(data)` · `render(width): string[]` · `focused` · `width`
- 工具函数来自 `@earendil-works/pi-tui`：`matchesKey` · `truncateToWidth` · `visibleWidth` · `CURSOR_MARKER` · `theme.fg(role, text)`
- 键位：`matchesKey(data,"up"|"down"|"return"|"escape")`；本工具用 ↑↓ 选类目、→ 展开、Esc 关闭
- **必须在命令 handler 内**取数据：`getSystemPromptOptions()` 仅 `ExtensionCommandContext` 有（事件里调会死锁）

---

## F. 落地前要钉的坑清单 `[综合]`

1. **压缩后 null 守卫**：复刻 `getContextUsage` 逻辑，无"压缩后 assistant usage"时显示"未校准/估算"而非假总量。
2. **totalTokens 含 output**：决定用 `input+cacheRead` 还是 `totalTokens`（建议前者表示"当前占用"）。
3. **`display:false` 的 custom_message**：占 context 但界面看不见——本工具要点名。
4. **瞬态注入**（`context` 事件/payload 重写）：JSONL 看不到；如需覆盖，额外挂 `pi.on("context",...)` 缓存最近一次 `event.messages`，与 `buildSessionContext()` diff。v1 可先只做落盘部分，标注"瞬态注入未统计"。
5. **图片**：沿用 pi 的 4800 chars/张约定，保持与 footer 一致。
6. **敏感数据**：`getSystemPromptOptions()` 含 context file 全文，不写日志/不进命令元数据。

（可选）轻量校准脚本：取当前 session，`sum(各类目 chars/4)` vs 最后一条 assistant `usage.input`，打印比值和中文/拉丁字符占比——用来判断是否需要上 CJK 加权。**非 v1 必需**。

---

## 对 REQUIREMENTS §8 的回填建议
- [x] tiktoken：**不引**，v1 复用 pi `estimateTokens` + 真值归一
- [x] CJK 系数：v1 不做，靠真值归一兜底；若实测中文占比失真明显，v2 上 CJK 加权（方案 2）
- [x] top-N：默认 5
- [x] 阈值：v1 硬编码，v2 settings 化
- [x] `--json` 导出：v2
