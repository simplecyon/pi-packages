# pi-context-inspector

一个 pi extension，注册 `/context` 命令，弹出 TUI 面板，按**类目**展示当前会话 context 被谁占据，并给出体检建议。

照出「看不见的固定开销」——system prompt / skill 元数据 / context files / 工具 schema——以及最大的几个 tool result，帮你判断该不该 `/compact` 或裁剪加载项。

## 面板内容

```
📊 Context  48.2k / 200.0k  ██████░░░░ 24%
── 固定开销（每轮都发）  18.4k  38% ──
   System prompt (base+guidelines)        1.3k    3%
 ▸ Context files (3)                       4.8k   10%
   Skill 元数据 (52)                       9.1k   19%
   工具 schema + 协议开销 (推算)           3.2k    7%
── 会话内容  29.8k  62% ──
 ▸ Tool results                           21.0k   44%
   对话消息 (user/assistant/thinking)      7.4k   15%
💡 建议
  • Skill 元数据占 19%（52 个）——可裁剪加载的 skill
  • 最大 tool result（read AGENTS.md）占 13%——考虑 /compact
↑↓ 选择 · →/Enter 展开 · Esc 关闭
```

- `▸` 的行可展开看 top-5 明细（context files 列表 / 最大的 tool results）
- 头部进度条为占窗口比例；`(未校准·估算)` 表示暂无 provider usage 可锚定（如刚 `/compact` 后、还没有新回复）

## 用法

```
/context
```

在任意交互会话里输入即可弹出面板，`Esc` 关闭。

## 安装

源码放在本仓库，通过 symlink 挂进 pi 全局扩展目录（源码隔离 + 全局可用）：

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/index.ts" ~/.pi/agent/extensions/pi-context-inspector.ts
```

或在 `~/.pi/agent/settings.json` 里引用：

```json
{ "extensions": ["/abs/path/to/pi-context-inspector/index.ts"] }
```

或临时试用：`pi -e ./index.ts`

## 计量口径（重要）

- token 数为**估算**，复用 pi 内部 `estimateTokens`（chars/4），与 footer 数字同口径
- **总量**用 provider usage（`getContextUsage()`）锚定；**类目分布**用估算算相对占比
- `工具 schema + 协议开销` = 真实总量 − 各估算类目之和（残差），比硬估更诚实
- chars/4 对中文偏低估 → 中文类目（如 AGENTS.md、中文对话）相对占比会略偏小；总量因锚定不受影响
- 详见 `RESEARCH.md`

## v1.2 更新

- **堆叠条以 100% context window 为参照**：已用部分按类目着色，未用部分 dim ░——一眼看到窗口还剩多少
- **Tool schema 单独计量**：从 `pi.getAllTools()` 拿活跃工具的 JSON schema，估算其 token——偏差从 ~14% 降到 ~6%
- 残差改标"估算偏差"（不再含 schema）

## v1.1 修复

- realTotal 用 input+cacheRead+cacheWrite（排除 output），不再用含输出的 totalTokens
- context file 标签带父目录（区分同名文件如 Repositories/CLAUDE.md vs Cyon-Obsidian/CLAUDE.md）
- tool result 标签关联 toolCallId → arguments，显示具体命令/路径而非仅工具名
- 对话拆分：user / assistant(text+tool calls) / thinking 三列

## 已知限制（v1）

- 只统计**落盘**内容；`context` 事件/payload 重写的**瞬态注入**未计（面板不含）
- 阈值硬编码，未 settings 化
- 无 `--json` 导出

规划见 `REQUIREMENTS.md §8`。

## 文件

- `index.ts` — 扩展本体
- `REQUIREMENTS.md` — 需求文档
- `RESEARCH.md` — 最佳实践调研（pi 源码验证 + 业界对照）
