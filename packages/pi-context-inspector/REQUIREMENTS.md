# pi-context-inspector — 需求文档

> 一个 pi extension，注册 `/context` 命令，弹出 TUI 面板，按**类目**展示当前会话 context 被谁占据，并给出体检建议。

状态：需求定稿，待开发
适用：pi v0.82.1+（session v3，extensions API）
Provider：wenge（自定义，tokenizer 不可直接获取 → 见 §4）

---

## 1. 目标与非目标

**目标**
- 照出"当前 session 的 context 被哪些内容占据"，重点是**看不见的固定开销**（system / skills / tools / context files）+ **最大的几个 tool result**
- 类目级占比一屏看懂，可展开某类看 top-N 明细
- 给出可行动的体检建议（该 /compact、该裁 skill 等）

**非目标**
- 不做逐条消息全量流水（噪音大，非核心诉求）
- 不追求 token 精确到个位（wenge tokenizer 拿不到，见 §4）
- 不做跨 session 历史趋势（首版只看当前 session）

---

## 2. 形态与交互（已定）

- **形态**：pi extension，注册斜杠命令 `/context`
- **视图**：类目汇总视图（10 类，见 §3）
- **UI**：弹窗式 TUI 面板（覆盖 editor，Esc 关闭）
- **建议**：面板底部带体检建议区
- **展开**：类目可展开看 top-N 明细（如 tool results 里最大的 5 次）

首版第一屏重心（用户明确）：**固定开销 + 最大 tool results** 排前，对话流水靠后。

---

## 3. Context 类目模型

工具要把当前送进模型的内容拆成以下类目：

| # | 类目 | 数据来源 | 落盘? | 备注 |
|---|------|---------|:---:|------|
| 1 | 基础 system prompt | `ctx.getSystemPrompt()` | — | 固定开销 |
| 2 | 追加 system (`APPEND_SYSTEM.md`) | `getSystemPromptOptions().appendedSystemPrompt` | — | |
| 3 | Context files (AGENTS/CLAUDE) | `getSystemPromptOptions().contextFiles` | — | 本 vault 很大 |
| 4 | 工具定义 / schema | `getSystemPromptOptions().activeTools`(+snippets) | — | 常被低估 5–15K |
| 5 | Skill 元数据 | `getSystemPromptOptions().loadedSkills` | — | ~50 个，盲区大户 |
| 6 | 对话消息 (user/assistant/thinking) | `buildSessionContext()` / `context` 事件 | ✅ | |
| 7 | Tool results (文件读取 / bash 输出) | 同上 | ✅ | 增长最快 |
| 8 | 图片 (base64) | ImageContent blocks | ✅ | 单张可上万 |
| 9 | 压缩 / 分支摘要 (+retainedTail) | compaction / branch_summary | ✅ | |
| 10 | 扩展注入消息 | custom_message 条目 + `context` 事件截获的瞬态注入 | 部分 | 落盘 vs 瞬态需分别标注 |

**类目 10 的两种子来源必须区分**：
- `custom_message` 条目 = 扩展落盘注入，像 UserMessage 进 context（注意 `display:false` 的界面看不见但占 context）
- `context` 事件 / `before_provider_request` 重写 = 瞬态注入，不落盘，只有本扩展挂 `context` 钩子才能截获
- `type:"custom"` 条目 = 扩展状态，**不进 context，跳过**

---

## 4. Token 计量策略（核心技术约束）

### 三个坑
1. **per-message usage 不能相加**：assistant 消息的 `usage.input` 是那次调用的**累计 context**（system+全历史+tools），不是单条大小。逐块统计必须**重建当前 context 再自己 tokenize**，不能读 usage 求和。
2. **wenge tokenizer 不可得**：无法精确分词。
3. **固定开销易被忽视**：system+skills+tools+context files 往往比对话本身大。

### 混合方案（推荐）
- **分布**：用本地估算器算每个类目的**相对占比**
  - 首选 tiktoken (cl100k) 做代理；退化到 `chars/4`（CJK 按更高权重，如 chars/1.5，需校准）
- **总量真值锚定**：取最后一条 assistant 的 `usage.input`（= 真实喂入总量），或 `ctx.getContextUsage().tokens`，作为分母
- **归一**：各类目估算值按 `真值总量 / 估算总量` 比例缩放 → 显示"约 X tokens / Y%"
- 展示明确标注"估算"，不假装精确

### 上下文窗口占用
- 从 `ctx.model` / modelRegistry 拿 `contextWindow`，显示 `已用 / 窗口 = Z%` 进度条

---

## 5. 面板布局（草案）

```
┌─ /context ── session: <name> ── model: <id> ──────────────┐
│ Context: ~48,200 / 200,000 tokens  (24%)  [██████░░░░░░]   │
│ (tokens 为估算，总量以 provider usage 校准)                 │
├───────────────────────────────────────────────────────────┤
│ 固定开销 (每轮都发)                        ~18,400 (38%)    │
│   Skill 元数据 (52)                         9,100  (19%) ▸ │
│   Context files (AGENTS/CLAUDE ×3)          4,800  (10%) ▸ │
│   工具定义 (6 tools)                        3,200   (7%)   │
│   System prompt (base+append)               1,300   (3%)   │
├───────────────────────────────────────────────────────────┤
│ 会话内容                                   ~29,800 (62%)    │
│   Tool results                             21,000  (44%) ▸ │
│     └ read Cyon-Obsidian/AGENTS.md          6,200          │
│     └ bash grep ...                         3,900          │
│   对话消息 (user/assistant/thinking)        7,400  (15%)   │
│   扩展注入 (2 落盘 / 1 瞬态)                1,400   (3%) ▸ │
│   图片 (0)                                      0          │
│   压缩/分支摘要                                 0          │
├───────────────────────────────────────────────────────────┤
│ 💡 建议                                                     │
│  • Skill 元数据占 19%——可 /reload 前裁剪 loadedSkills      │
│  • Tool results 占 44%，最大一笔 6.2K——考虑 /compact       │
└─ ↑↓ 选择 · → 展开 · Esc 关闭 ──────────────────────────────┘
```

---

## 6. 建议引擎（阈值可配）

规则示例（首版硬编码阈值，后续 settings 化）：
- Skill 元数据 > 15% 或 > N 个 skill → 提示裁剪加载
- 单个 tool result > 10% 或某文件被重复读取 → 提示 /compact 或避免重读
- context files 总量 > 8% → 提示精简 AGENTS.md
- 总占用 > 70% 窗口 → 强提示 /compact
- 存在 `display:false` 的落盘扩展注入 → 提示"有隐藏注入占用"

---

## 7. 技术实现要点

- **入口**：`pi.registerCommand("context", { handler })`；命令上下文才有 `getSystemPromptOptions()`（事件里调会死锁）
- **固定开销**：`ctx.getSystemPromptOptions()` 一把拿到 custom prompt / activeTools / toolSnippets / guidelines / appended / contextFiles / loadedSkills
- **会话内容**：`ctx.sessionManager.buildSessionContext()` 拿实际 message list（已应用 compaction）
- **瞬态注入截获**（可选进阶）：挂 `pi.on("context", ...)` 缓存最近一次 `event.messages`，与 buildSessionContext 结果 diff 出瞬态注入量
- **真值总量**：`ctx.getContextUsage()`；或遍历找最后一条 assistant.usage
- **tokenizer**：优先 tiktoken；打包体积/依赖需评估，退化到字符估算
- **窗口大小**：`ctx.model` → `context_window`
- **TUI 面板**：参考 `docs/tui.md` 的自定义 UI（editor 替换式面板）；`ctx.ui` 能力见 extensions.md §ctx.ui
- **敏感数据**：`getSystemPromptOptions()` 含 context file 全文，属扩展本地敏感数据，**不得写日志 / 不进命令元数据 / 不外泄**

---

## 8. 决策记录（调研后回填，详见 RESEARCH.md）

- [x] **tokenizer**：v1 **不引 tiktoken**，直接复用 pi 导出的 `estimateTokens`(chars/4) + 真值 usage 归一（与 pi footer 数字一致）
- [x] **CJK 系数**：v1 不做，靠真值归一兜底总量；若实测中文类目占比失真明显，v2 升级 CJK 加权（中文≈0.6/字、拉丁≈0.25/字）
- [x] **top-N**：默认 5
- [x] **阈值**：v1 硬编码，v2 settings 化
- [x] **`--json` 导出**：v2

关键实现坑（RESEARCH §F）：压缩后 null 守卫、`input+cacheRead` vs `totalTokens` 取舍、`display:false` 注入点名、瞬态注入 v1 暂不统计（标注）、图片沿用 4800 chars/张。

---

## 附：参考文档（pi 安装目录 docs/）
- `session-format.md` — 消息类型 / buildSessionContext / custom_message vs custom
- `extensions.md` — registerCommand / getSystemPromptOptions / getContextUsage / context 事件
- `tui.md` — 自定义 TUI 面板
- `settings.md` — 若做阈值配置
