/**
 * pi-context-inspector — /context
 *
 * 弹窗 TUI 面板，按类目展示当前会话 context 被谁占据，并给出体检建议。
 *
 * v1.1 修复：
 *  - realTotal 用 input+cacheRead+cacheWrite（排除 output），不再用含输出的 totalTokens
 *  - context file 标签带父目录（区分同名文件如 Repositories/CLAUDE.md vs Cyon-Obsidian/CLAUDE.md）
 *  - tool result 标签关联 toolCallId → arguments，显示具体命令/路径而非仅工具名
 *  - 对话拆分：user / assistant(text+tool calls) / thinking 三列
 *  - 残差改标"估算偏差"（tool schema 已单独计量），附校准行（估算合计 vs 真值），不再伪装精确
 *
 * v1.2：
 *  - 去掉堆叠条下方的图例行，改为在每个列表行前加同色 ■ 色块，进度条分段与列表行直接对应
 *
 * v1.3：
 *  - 固定开销四项（System base / Context files / Skills / Tool schema）支持 Enter 展开，直接展示发给 API 的对应请求内容
 *  - Context files 明细合并为单块展示（不再按文件拆行）
 *  - 估算偏差分段/色块改用虚线块（▒/▨），与实测内容区分
 *
 * v1.4：
 *  - 去掉折叠箭头与行内展开，改为 Enter 打开二级窗口查看全文（↑↓ 滚动、PgUp/PgDn 翻页、Esc 返回）
 *  - Tool results 的明细同样移入二级窗口，展示完整列表
 *
 * v1.5：
 *  - token 估算区分 CJK：非 CJK 4 chars/tok，CJK 1.5 chars/tok（原统一 /4 会严重低估中文内容）
 *
 * v1.6：
 *  - 新增「隐藏偏差」模式（按 h 切换，仅校准后可用）：各类目估算值按 真值/估算合计 等比缩放，
 *    偏差段/偏差行不显示，校准行提示缩放系数
 *
 * v1.7：
 *  - 堆叠条 / 分组 / 分组之间改用一个空白行做固定间距（去掉多余分割线）
 *  - 分组标题改为 `title ──── xxk  xx%`，数据右对齐
 *  - 行标签去掉括号备注，仅保留 Skill 计数
 */

import {
	buildSessionContext,
	estimateTokens,
	formatSkillsForPrompt,
	getLastAssistantUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const IMAGE_TOKENS = 1200; // pi 约定：图片按 4800 chars 计 → /4
const PANEL_WIDTH = 82;

// ---- Module-level memory state (fed by memory-injection via pi.events) ----
// Events are the primary channel; computeBreakdown also falls back to
// session entries in case the inspector loads mid-session without a fresh
// session_start event.
let _eventsBaseFiles: { path: string; content: string }[] = [];

/** 判断码点是否为 CJK（中日韩表意文字、假名、谚文、全角/中文标点） */
function isCJK(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303f) || // 部首/表意符号 + CJK 标点（、。「」【】）
		(cp >= 0x3040 && cp <= 0x30ff) || // 平/片假名
		(cp >= 0x3400 && cp <= 0x4dbf) || // 汉字扩展 A
		(cp >= 0x4e00 && cp <= 0x9fff) || // 基本汉字
		(cp >= 0xac00 && cp <= 0xd7af) || // Hangul 音节
		(cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
		(cp >= 0xff00 && cp <= 0xffef) || // 全角 ASCII / 半角片假名
		(cp >= 0x20000 && cp <= 0x2fa1f) // 汉字扩展 B–F（增补平面）
	);
}

// CJK 密度经验值：cl100k/o200k 下常见中文 ≈ 1.5 字/token（比 ASCII 的 4 chars/tok 贵 ~2.7 倍）
const CJK_CHARS_PER_TOKEN = 1.5;

/** 混合文本 token 估算：非 CJK 按 4 chars/tok，CJK 按 1.5 chars/tok，按码点计数（不受 UTF-16 代理对影响） */
const est = (s: string | undefined | null): number => {
	if (!s) return 0;
	let cjk = 0;
	let total = 0;
	for (const ch of s) {
		total++;
		if (isCJK(ch.codePointAt(0)!)) cjk++;
	}
	return Math.ceil((total - cjk) / 4 + cjk / CJK_CHARS_PER_TOKEN);
};

interface Breakdown {
	// 固定开销
	systemBase: number;
	systemBaseText: string;
	contextFiles: number;
	contextFilesText: string; // 所有 context file 合并后的完整文本
	skills: number;
	skillsText: string;
	skillCount: number;
	contextFileDetails: { path: string; tokens: number }[];
	toolSchemas: number; // 活跃工具的 JSON schema（发给 API，不在 system prompt 里）
	toolSchemasText: string;
	// 会话内容
	userText: number;
	assistantText: number; // 含 text + toolCall 序列化
	thinking: number;
	toolResults: number;
	injections: number;
	summaries: number;
	images: number;
	memory: number;
	memoryText: string;
	memoryFileCount: number;
	toolResultDetails: { label: string; tokens: number }[];
	// 汇总
	estimatedSum: number;
	realTotal: number | null; // input+cacheRead+cacheWrite；null = 未校准
	residual: number | null; // 真值 − 各估算之和（现已含 toolSchemas，剩余为纯偏差）
	contextWindow: number;
	windowPercent: number | null;
}

/** 从 toolCall arguments 生成可读标签 */
function formatToolLabel(name: string | undefined, args: any): string {
	const n = name ?? "tool";
	if (!args || typeof args !== "object") return n;
	const cmd = args.command;
	const path = args.path;
	const query = args.query;
	switch (n) {
		case "bash":
			return `bash: ${String(cmd ?? "").split("\n")[0].slice(0, 44)}`;
		case "read":
			return `read: ${basename(path)}`;
		case "edit":
			return `edit: ${basename(path)}`;
		case "write":
			return `write: ${basename(path)}`;
		case "search_vault":
			return `search: ${String(query ?? "").slice(0, 36)}`;
		default:
			return n;
	}
}

function basename(p: string | undefined): string {
	if (!p) return "?";
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

function computeBreakdown(ctx: ExtensionCommandContext, pi: ExtensionAPI): Breakdown {
	// ---- 固定开销 ----
	const opts = ctx.getSystemPromptOptions();
	const skillsList = opts.skills ?? [];
	const skillsText = skillsList.length > 0 ? formatSkillsForPrompt(skillsList) : "";
	const skills = est(skillsText);

	const contextFilesList = opts.contextFiles ?? [];
	const contextFileDetails = contextFilesList.map((f) => ({
		path: f.path,
		tokens: est(f.content),
	}));
	const contextFiles = contextFileDetails.reduce((s, f) => s + f.tokens, 0);
	const contextFilesText = contextFilesList
		.map((f) => `──── ${f.path} ────\n${f.content}`)
		.join("\n\n");

	// system base = 完整 system prompt − skills 段落 − context files 内容
	const fullSystemText = ctx.getSystemPrompt();
	const fullSystem = est(fullSystemText);
	let systemBase = Math.max(0, fullSystem - skills - contextFiles);
	// system base 文本 = 完整 prompt 去掉 skills 段与各 context file 内容后的剩余部分
	let systemBaseText = fullSystemText;
	if (skillsText) systemBaseText = systemBaseText.replace(skillsText, "");
	for (const f of contextFilesList) systemBaseText = systemBaseText.replace(f.content, "");
	systemBaseText = systemBaseText.trim();

	// ---- 工具 schema（发给 API 的 JSON，不在 system prompt 里）----
	const activeTools = new Set(pi.getActiveTools());
	let toolSchemas = 0;
	const toolSchemaParts: string[] = [];
	try {
		for (const t of pi.getAllTools()) {
			if (!activeTools.has(t.name)) continue;
			const params = JSON.stringify(t.parameters ?? {});
			// promptGuidelines already live in the effective system prompt.
			// Only count the tool definition fields sent separately to the API.
			toolSchemas += est(t.description) + est(params) + est(t.name);
			toolSchemaParts.push(`● ${t.name}\n${t.description}\n${params}`);
		}
	} catch {
		// getAllTools 在某些上下文可能不可用，退化为 0
	}
	const toolSchemasText = toolSchemaParts.join("\n\n");

	// ---- 会话内容（block 级拆分，更精确归因）----
	let userText = 0;
	let assistantText = 0;
	let thinking = 0;
	let toolResults = 0;
	let injections = 0;
	let summaries = 0;
	let images = 0;
	let memory = 0;
	let memoryText = "";
	let memoryFileCount = 0;
	const toolResultDetails: { label: string; tokens: number }[] = [];

	const countImages = (content: unknown): number => {
		if (!Array.isArray(content)) return 0;
		return content.filter((b: any) => b?.type === "image").length;
	};

	// ---- Memory（跨 memory-injection 扩展读取）----
	// Primary: module-level state populated by pi.events listener.
	// Fallback: scan session entries (survives /resume when events aren't re-emitted).
	let baseFiles: { path: string; content: string }[] = _eventsBaseFiles;
	if (baseFiles.length === 0) {
		const rawEntries = ctx.sessionManager.getEntries();
		let lastMemoryBase: any = null;
		for (const e of rawEntries) {
			if ((e as any).type === "custom" && (e as any).customType === "memory-base-injection") {
				lastMemoryBase = e;
			}
		}
		if (lastMemoryBase) {
			baseFiles = (lastMemoryBase as any).data?.files ?? [];
		}
	}
	for (const f of baseFiles) {
		const tok = est(f.content);
		memory += tok;
		memoryText += `BASE · ${f.path}\n${"─".repeat(60)}\n${f.content}\n\n`;
		memoryFileCount++;
		systemBaseText = systemBaseText.replace(f.content, "");
	}
	// Base memory is already embedded in fullSystemText by memory-injection.
	// Move it out of System instead of counting it a second time.
	systemBase = Math.max(0, systemBase - memory);
	systemBaseText = systemBaseText.trim();

	const sctx = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const messages = sctx.messages as any[];

	// 先建 toolCallId → arguments 映射，用于 tool result 标签
	const toolCallMap = new Map<string, { name: string; arguments: any }>();
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type === "toolCall" && b.id) {
					toolCallMap.set(b.id, { name: b.name, arguments: b.arguments });
				}
			}
		}
	}

	for (const m of messages) {
		images += countImages(m.content) * IMAGE_TOKENS;

		switch (m.role) {
			case "user":
				if (typeof m.content === "string") userText += est(m.content);
				else if (Array.isArray(m.content))
					for (const b of m.content) if (b?.type === "text") userText += est(b.text);
				break;
			case "assistant":
				if (Array.isArray(m.content)) {
					for (const b of m.content) {
						if (b?.type === "thinking") thinking += est(b.thinking);
						else if (b?.type === "text") assistantText += est(b.text);
						else if (b?.type === "toolCall")
							assistantText += est(b.name + JSON.stringify(b.arguments));
					}
				}
				break;
			case "toolResult": {
				let tok = 0;
				if (Array.isArray(m.content)) {
					for (const b of m.content) if (b?.type === "text") tok += est(b.text);
				} else if (typeof m.content === "string") tok = est(m.content);
				toolResults += tok;
				const call = toolCallMap.get(m.toolCallId);
				const label = formatToolLabel(m.toolName ?? call?.name, call?.arguments);
				toolResultDetails.push({ label, tokens: tok });
				break;
			}
			case "bashExecution": {
				const tok = est(m.command) + est(m.output);
				toolResults += tok;
				toolResultDetails.push({
					label: `bash: ${String(m.command ?? "").split("\n")[0].slice(0, 44)}`,
					tokens: tok,
				});
				break;
			}
			case "custom":
				// Scope memory（customType === "memory-auto-read"）归入 Memory 类目
				if ((m as any).customType === "memory-auto-read") {
					const tok = est(m.content);
					memory += tok;
					const memPath = (m as any).details?.memoryPath ?? (m as any).details?.scopeDir ?? "unknown scope";
					memoryText += `SCOPE · ${memPath}\n${"─".repeat(60)}\n${typeof m.content === "string" ? m.content : ""}\n\n`;
					memoryFileCount++;
				} else {
					injections += est(m.content);
				}
				break;
			case "compactionSummary":
			case "branchSummary":
				summaries += est(m.content);
				break;
			default:
				// fallback：整体估
				assistantText += estimateTokens(m);
		}
	}
	toolResultDetails.sort((a, b) => b.tokens - a.tokens);

	const estimatedSum =
		systemBase + contextFiles + skills + toolSchemas + memory + userText + assistantText + thinking + toolResults + injections + summaries + images;

	// ---- 真值锚定：input + cacheRead + cacheWrite（排除 output）----
	const ctxUsage = ctx.getContextUsage();
	const rawUsage = getLastAssistantUsage(ctx.sessionManager.getEntries());
	const contextWindow = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	let realTotal: number | null = null;
	if (ctxUsage?.tokens != null && rawUsage) {
		realTotal = (rawUsage.input ?? 0) + (rawUsage.cacheRead ?? 0) + (rawUsage.cacheWrite ?? 0);
	}
	const residual = realTotal != null ? realTotal - estimatedSum : null;
	const windowPercent = contextWindow > 0 ? ((realTotal ?? estimatedSum) / contextWindow) * 100 : null;

	return {
		systemBase,
		systemBaseText,
		contextFiles,
		contextFilesText,
		skills,
		skillsText,
		skillCount: skillsList.length,
		contextFileDetails: contextFileDetails.sort((a, b) => b.tokens - a.tokens),
		toolSchemas,
		toolSchemasText,
		userText,
		assistantText,
		thinking,
		toolResults,
		injections,
		summaries,
		images,
		memory,
		memoryText: memoryText.trimEnd(),
		memoryFileCount,
		toolResultDetails,
		estimatedSum,
		realTotal,
		residual,
		contextWindow,
		windowPercent,
	};
}

// ---- 建议引擎（v1 硬编码阈值）----
function buildSuggestions(b: Breakdown): string[] {
	const D = b.realTotal ?? b.estimatedSum; // 占比分母
	const out: string[] = [];
	const pct = (n: number) => (D > 0 ? (n / D) * 100 : 0);

	if (b.windowPercent != null && b.windowPercent > 70) {
		out.push(`上下文已用 ${b.windowPercent.toFixed(0)}% 窗口，建议 /compact`);
	}
	if (pct(b.skills) > 15) {
		out.push(`Skill 元数据占 ${pct(b.skills).toFixed(0)}%（${b.skillCount} 个）——可裁剪加载的 skill`);
	}
	if (pct(b.contextFiles) > 8) {
		out.push(`Context files 占 ${pct(b.contextFiles).toFixed(0)}%——考虑精简 AGENTS.md/CLAUDE.md`);
	}
	const biggest = b.toolResultDetails[0];
	if (biggest && pct(biggest.tokens) > 10) {
		out.push(`最大 tool result（${biggest.label}）占 ${pct(biggest.tokens).toFixed(0)}%——考虑 /compact`);
	}
	if (pct(b.thinking) > 20) {
		out.push(`Thinking 占 ${pct(b.thinking).toFixed(0)}%——可降低 reasoning level`);
	}
	if (b.injections > 0) {
		out.push(`存在扩展落盘注入（${fmtTok(b.injections)}）——注意 display:false 的隐藏占用`);
	}
	if (out.length === 0) out.push("context 分布健康，无明显冗余");
	return out;
}

function fmtTok(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1)}k`;
}

function bar(pct: number, len = 10): string {
	const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
	return "█".repeat(filled) + "░".repeat(len - filled);
}

interface BarSegment {
	role: ThemeColor;
	label: string;
	tokens: number;
	dashed?: boolean; // 估算类分段：虚线块渲染
}

/** 构建堆叠条分段：固定开销 → 会话内容 → 偏差，每段用语义颜色。scale≠1（隐藏偏差模式）时各分段等比缩放且不输出偏差段 */
function buildBarSegments(b: Breakdown, scale = 1): BarSegment[] {
	const t = (n: number) => Math.round(n * scale);
	const segs: BarSegment[] = [
		{ role: "dim", label: "System", tokens: t(b.systemBase) },
		{ role: "warning", label: "Ctx files", tokens: t(b.contextFiles) },
		{ role: "accent", label: "Skills", tokens: t(b.skills) },
		{ role: "bashMode", label: "Tool schema", tokens: t(b.toolSchemas) },
		{ role: "error", label: "Tool results", tokens: t(b.toolResults) },
		{ role: "success", label: "Assistant", tokens: t(b.assistantText) },
		{ role: "thinkingText", label: "Thinking", tokens: t(b.thinking) },
		{ role: "userMessageText", label: "User", tokens: t(b.userText) },
	];
	if (b.memory > 0) segs.push({ role: "customMessageText", label: "Memory", tokens: t(b.memory) });
	if (b.injections > 0) segs.push({ role: "customMessageText", label: "注入", tokens: t(b.injections) });
	if (b.summaries > 0) segs.push({ role: "mdQuote", label: "摘要", tokens: t(b.summaries) });
	if (b.images > 0) segs.push({ role: "syntaxString", label: "图片", tokens: t(b.images) });
	if (scale === 1 && b.residual != null && b.residual > 0)
		segs.push({ role: "muted", label: "偏差", tokens: b.residual, dashed: true });
	return segs.filter((s) => s.tokens > 0);
}

const DETAIL_FRAME_ROWS = 6; // 上边框 + 标题 + 分隔线 + 分隔线 + footer + 下边框
const DETAIL_MAX_ROWS = 25; // 二级窗口最多显示 25 行正文

class ContextPanel {
	focused = false;
	private expandKeys: string[];
	private selected = 0;
	private detail: { title: string; text: string } | null = null;
	private detailScroll = 0;
	private renderWidth = PANEL_WIDTH;
	private hideDeviation = true; // 隐藏偏差模式（默认开启）：估算按真值等比缩放

	/** 隐藏偏差模式下的缩放系数（未校准或未开启时为 1） */
	private scaleFactor(): number {
		const b = this.b;
		return this.hideDeviation && b.realTotal != null && b.estimatedSum > 0
			? b.realTotal / b.estimatedSum
			: 1;
	}

	/** 按当前模式缩放 token 展示值 */
	private scaledTok(n: number): number {
		return Math.round(n * this.scaleFactor());
	}

	constructor(
		private theme: Theme,
		private b: Breakdown,
		private suggestions: string[],
		private done: (r: undefined) => void,
		private terminalRows: () => number,
	) {
		this.expandKeys = [];
		if (b.systemBaseText.length > 0) this.expandKeys.push("sysbase");
		if (b.contextFileDetails.length > 0) this.expandKeys.push("files");
		if (b.skillsText.length > 0) this.expandKeys.push("skills");
		if (b.toolSchemasText.length > 0) this.expandKeys.push("schemas");
		if (b.memory > 0) this.expandKeys.push("memory");
		if (b.toolResultDetails.length > 0) this.expandKeys.push("tools");
	}

	/** 按面板宽度换行（不截断，全文保留） */
	private wrapText(text: string, width: number): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			let line = raw;
			while (visibleWidth(line) > width) {
				let acc = 0;
				let i = 0;
				for (; i < line.length; i++) {
					acc += visibleWidth(line[i]!);
					if (acc > width) break;
				}
				out.push(line.slice(0, i));
				line = line.slice(i);
			}
			out.push(line);
		}
		return out;
	}

	private detailPageSize(): number {
		return Math.max(
			1,
			Math.min(DETAIL_MAX_ROWS, this.terminalRows() - DETAIL_FRAME_ROWS),
		);
	}

	private detailLines(): string[] {
		return this.detail
			? this.wrapText(this.detail.text, Math.max(1, this.renderWidth - 8))
			: [];
	}

	/** 打开二级窗口：展示选中类目的请求原文全文 */
	private openDetail(key: string): void {
		const b = this.b;
		let title = "";
		let text = "";
		switch (key) {
			case "sysbase":
				title = "System prompt (base+guidelines)";
				text = b.systemBaseText;
				break;
			case "files":
				title = `Context files (${b.contextFileDetails.length})`;
				text = b.contextFilesText;
				break;
			case "skills":
				title = `Skill 元数据 (${b.skillCount})`;
				text = b.skillsText;
				break;
			case "schemas":
				title = "Tool schema (JSON, 发给 API)";
				text = b.toolSchemasText;
				break;
			case "tools":
				title = `Tool results (${b.toolResultDetails.length})`;
				text = b.toolResultDetails
					.map((d) => `${fmtTok(this.scaledTok(d.tokens)).padStart(7)}  ${d.label}`)
					.join("\n");
				break;
			case "memory":
				title = `Memory (${b.memoryFileCount} 份 MEMORY.md)`;
				text = b.memoryText;
				break;
			default:
				return;
		}
		this.detail = { title, text };
		this.detailScroll = 0;
	}

	handleInput(data: string): void {
		// 二级窗口内：滚动 / 返回
		if (this.detail) {
			const pageSize = this.detailPageSize();
			const maxScroll = Math.max(0, this.detailLines().length - pageSize);
			if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "left")) {
				this.detail = null;
			} else if (matchesKey(data, "up")) {
				this.detailScroll = Math.max(0, this.detailScroll - 1);
			} else if (matchesKey(data, "down")) {
				this.detailScroll = Math.min(maxScroll, this.detailScroll + 1);
			} else if (matchesKey(data, "pageUp")) {
				this.detailScroll = Math.max(0, this.detailScroll - pageSize);
			} else if (matchesKey(data, "pageDown")) {
				this.detailScroll = Math.min(maxScroll, this.detailScroll + pageSize);
			}
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		// h：切换隐藏偏差模式（仅在校准后可用）
		if (data === "h" && this.b.realTotal != null) {
			this.hideDeviation = !this.hideDeviation;
			return;
		}
		if (this.expandKeys.length === 0) return;
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.expandKeys.length - 1, this.selected + 1);
		} else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			this.openDetail(this.expandKeys[this.selected]!);
		}
	}

	private pctOf(n: number): number {
		const D = this.b.realTotal ?? this.b.estimatedSum;
		return D > 0 ? (n / D) * 100 : 0;
	}

	/** 二级窗口：全文查看 */
	private renderDetail(): string[] {
		const th = this.theme;
		const innerW = Math.max(1, this.renderWidth - 2);
		const d = this.detail!;
		const detailLines = this.detailLines();
		const pageSize = this.detailPageSize();
		const maxScroll = Math.max(0, detailLines.length - pageSize);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const lines: string[] = [];
		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (c: string) => th.fg("border", "│") + pad(c, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", d.title)} ${th.fg("dim", `· ${detailLines.length} 行`)}`));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		const page = detailLines.slice(this.detailScroll, this.detailScroll + pageSize);
		for (const l of page) lines.push(row(`  ${th.fg("text", l)}`));
		for (let i = page.length; i < pageSize; i++) lines.push(row(""));
		lines.push(th.fg("border", `├${"─".repeat(innerW)}┤`));
		const pos = `${Math.min(this.detailScroll + 1, detailLines.length)}-${Math.min(this.detailScroll + pageSize, detailLines.length)} / ${detailLines.length}`;
		lines.push(
			row(` ${th.fg("dim", `${pos} 行 · ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 返回`)}${CURSOR_MARKER}`),
		);
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	render(width: number): string[] {
		this.renderWidth = Math.min(PANEL_WIDTH, Math.max(1, width));
		if (this.detail) return this.renderDetail();
		const th = this.theme;
		const w = this.renderWidth;
		const innerW = Math.max(1, w - 2);
		const lines: string[] = [];
		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (c: string) => th.fg("border", "│") + pad(c, innerW) + th.fg("border", "│");
		const sep = () => th.fg("border", `├${"─".repeat(innerW)}┤`);

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		const b = this.b;
		const used = b.realTotal ?? b.estimatedSum;
		const wp = b.windowPercent ?? 0;
		const calib = b.realTotal != null ? "" : th.fg("warning", " (未校准·估算)");
		lines.push(
			row(
				` ${th.fg("accent", "📊 Context")}  ${fmtTok(used)} / ${fmtTok(b.contextWindow)}  ${th.fg("dim", bar(wp))} ${wp.toFixed(0)}%${calib}`,
			),
		);
		// 校准行：估算合计 vs 真值
		if (b.realTotal != null) {
			if (this.hideDeviation) {
				const f = this.scaleFactor();
				lines.push(
					row(
						` ${th.fg("dim", `估算合计已按真值对齐 ×${f.toFixed(2)} · 偏差 ${fmtTok(Math.abs(b.residual ?? 0))} 已按比例摊入各类目`)}`,
					),
				);
			} else {
				const diff = b.residual ?? 0;
				const diffPct = b.realTotal > 0 ? (Math.abs(diff) / b.realTotal) * 100 : 0;
				const diffCol = diff > 0 ? th.fg("warning", `+${fmtTok(diff)}`) : th.fg("success", fmtTok(diff));
				lines.push(
					row(
						` ${th.fg("dim", `估算 ${fmtTok(b.estimatedSum)} · 真值 ${fmtTok(b.realTotal)} · 差值 ${diffCol} (${diffPct.toFixed(0)}% 为估算偏差)`)}`,
					),
				);
			}
		}
		lines.push(sep());

		// 堆叠条：以 100% context window 为参照，已用部分按类目着色，未用部分 dim ░
		const win = b.contextWindow || (b.realTotal ?? b.estimatedSum);
		const segs = buildBarSegments(b, this.scaleFactor());
			let barStr = "";
			let barUsed = 0;
			const barWidth = innerW - 1;
			for (const s of segs) {
				const sw = Math.min(
					Math.max(0, barWidth - barUsed),
					Math.round((s.tokens / win) * barWidth),
				);
				if (sw > 0) {
					barStr += th.fg(s.role, (s.dashed ? "▒" : "█").repeat(sw));
					barUsed += sw;
				}
			}
			barStr += th.fg("dim", "░".repeat(Math.max(0, barWidth - barUsed)));
		lines.push(row(` ${barStr}`));
		lines.push(row("")); // 堆叠条与分组之间的固定间距

		const itemRow = (
			label: string,
			tokens: number,
			opts: { key?: string; color?: ThemeColor; dashed?: boolean } = {},
		) => {
			tokens = this.scaledTok(tokens);
			const p = this.pctOf(tokens);
			const isSel = opts.key && this.expandKeys[this.selected] === opts.key;
			const indent = "   ";
			const chip = opts.color ? th.fg(opts.color, opts.dashed ? "▨ " : "■ ") : "";
			const labelText = isSel ? th.fg("accent", label) : th.fg("text", label);
			const right = `${fmtTok(tokens).padStart(6)}  ${p.toFixed(0).padStart(3)}%`;
			const left = `${indent}${chip}${labelText}`;
			const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(right) - 1);
			return row(`${left}${" ".repeat(gap)}${th.fg("dim", right)}`);
		};

		// 分组标题：title ─────── xxk  xx%（数据右对齐）
		const groupRow = (title: string, tokens: number) => {
			const scaled = this.scaledTok(tokens);
			const right = `${fmtTok(scaled)}  ${this.pctOf(scaled).toFixed(0)}%`;
			const left = ` ${th.fg("text", title)} `;
			const dashLen = Math.max(2, innerW - visibleWidth(left) - visibleWidth(right) - 2);
			return row(`${left}${th.fg("dim", "─".repeat(dashLen))} ${th.fg("dim", right)}`);
		};

		// 固定开销
		const fixed = b.systemBase + b.contextFiles + b.skills + b.toolSchemas + b.memory;
		lines.push(groupRow("固定开销", fixed));
		lines.push(itemRow("System prompt", b.systemBase, { color: "dim", key: "sysbase" }));
		lines.push(itemRow("Context files", b.contextFiles, { key: "files", color: "warning" }));
		lines.push(itemRow(`Skill 元数据 (${b.skillCount})`, b.skills, { color: "accent", key: "skills" }));
		lines.push(itemRow("Tool schema", b.toolSchemas, { color: "bashMode", key: "schemas" }));
		if (b.memory > 0) lines.push(itemRow(`Memory (${b.memoryFileCount} 份)`, b.memory, { color: "customMessageText", key: "memory" }));
		lines.push(row("")); // 分组之间的固定间距

		// 会话内容
		const conv = b.userText + b.assistantText + b.thinking + b.toolResults + b.injections + b.summaries + b.images;
		lines.push(groupRow("会话内容", conv));
		lines.push(itemRow("Tool results", b.toolResults, { key: "tools", color: "error" }));
		lines.push(itemRow("Assistant", b.assistantText, { color: "success" }));
		lines.push(itemRow("Thinking", b.thinking, { color: "thinkingText" }));
		lines.push(itemRow("User messages", b.userText, { color: "userMessageText" }));
		if (b.injections > 0) lines.push(itemRow("扩展注入", b.injections, { color: "customMessageText" }));
		if (b.summaries > 0) lines.push(itemRow("压缩/分支摘要", b.summaries, { color: "mdQuote" }));
		if (b.images > 0) lines.push(itemRow("图片", b.images, { color: "syntaxString" }));
		lines.push(sep());

		// 残差（纯偏差；隐藏偏差模式下整段含分割线一起隐藏，避免出现双分割线）
		if (b.residual != null && !this.hideDeviation) {
			lines.push(itemRow("估算偏差", b.residual, { color: "muted", dashed: true }));
			lines.push(sep());
		}

		// 建议
		lines.push(row(` ${th.fg("accent", "💡 建议")}`));
		for (const s of this.suggestions) {
			lines.push(row(`  ${th.fg("warning", "•")} ${truncateToWidth(s, innerW - 4)}`));
		}
		lines.push(sep());
		const devHint =
			b.realTotal != null
				? this.hideDeviation
					? " · h 显示偏差"
					: " · h 隐藏偏差"
				: "";
		lines.push(
			row(` ${th.fg("dim", `↑↓ 选择 · Enter 查看全文${devHint} · Esc 关闭`)}${CURSOR_MARKER}`),
		);
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	// Listen for memory-injection base-load events (primary channel)
	pi.events.on("memory-injection:base-loaded", (data: any) => {
		_eventsBaseFiles = data?.files ?? [];
	});

	pi.registerCommand("context", {
		description: "展示当前会话 context 的类目占用与体检建议",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const b = computeBreakdown(ctx, pi);
			const suggestions = buildSuggestions(b);
			if (ctx.mode !== "tui") {
				const used = b.realTotal ?? b.estimatedSum;
				const percent = b.windowPercent == null ? "unknown" : `${b.windowPercent.toFixed(0)}%`;
				ctx.ui.notify(
					`Context: ${fmtTok(used)} / ${fmtTok(b.contextWindow)} (${percent})\n${suggestions.join("\n")}`,
					"info",
				);
				return;
			}
			await ctx.ui.custom<undefined>(
				(tui, theme, _kb, done) =>
					new ContextPanel(theme, b, suggestions, done, () => tui.terminal.rows),
				{
					overlay: true,
					overlayOptions: {
						width: PANEL_WIDTH,
						maxHeight: "100%",
					},
				},
			);
		},
	});
}
