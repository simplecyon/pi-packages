/**
 * pi-safe-operation
 *
 * A single project-level safety boundary for:
 *   - destructive or scope-expanding local operations;
 *   - protected vault paths and code-output isolation;
 *   - recoverable deletion through the safe_delete tool;
 *   - deterministic secret redaction before tool output reaches the model.
 *
 * The extension deliberately blocks complex deletion syntax instead of trying
 * to emulate a full POSIX shell or PowerShell parser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSafePlanCommand, setupPermissionMode } from "./permission-mode.ts";
import type { InteractionMode } from "./permission-mode.ts";
import {
  DEFAULT_JUDGE_CONFIG,
  judgeAdjudicate,
  judgeRequestFromEvent,
  NON_CIRCUMVENTION_GUIDELINE,
  normalizeJudgeConfig,
} from "./judge.ts";
import type { JudgeConfig } from "./judge.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_DECISION_EVENT = "simplecyon:safe-operation:decision";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const suffix = ellipsis.slice(0, Math.min(ellipsis.length, width));
  return text.replace(ANSI_PATTERN, "").slice(0, Math.max(0, width - suffix.length)) + suffix;
}

type FileKind = "file" | "directory" | "symlink" | "other" | "missing";
type GitClass = "tracked" | "ignored" | "untracked" | "outside";

interface RedactionConfig {
  enabled: boolean;
  maxSecretDensity: number;
  scanToolResults: boolean;
  scanFinalContext: boolean;
}

interface SafeOperationConfig {
  version: number;
  mode: "balanced" | "strict";
  interactionMode: InteractionMode;
  protectedPaths: string[];
  noDeletePaths: string[];
  sensitivePaths: string[];
  knowledgeDirs: string[];
  maxExplicitTargets: number;
  recoverableDelete: boolean;
  redaction: RedactionConfig;
  judge: JudgeConfig;
}

interface InspectedTarget {
  requested: string;
  absolute: string;
  relative: string;
  realRelative: string;
  kind: FileKind;
  gitClass: GitClass;
  exists: boolean;
  protected: string | null;
  noDelete: string | null;
}

interface DeleteParse {
  kind: "files" | "git-clean" | "generated";
  commandName: string;
  targets: string[];
}

interface RedactionResult {
  text: string;
  count: number;
  redactedCharacters: number;
  kinds: Set<string>;
}

interface TrashManifestTarget {
  original: string;
  trashed: string;
}

interface TrashManifest {
  version: number;
  timestamp: string;
  reason: string;
  targets: TrashManifestTarget[];
  restorations?: Array<{
    timestamp: string;
    reason: string;
    targets: TrashManifestTarget[];
  }>;
}

interface ApprovalCopy {
  action: string;
  worthWhen: string;
  risks: string[];
  impact?: string[];
  saferChoice?: string;
  technicalDetails?: string;
}

const DEFAULT_CONFIG: SafeOperationConfig = {
  version: 1,
  mode: "balanced",
  interactionMode: "accept-edits",
  protectedPaths: [
    ".git",
    ".pi/safe-operation.json",
  ],
  noDeletePaths: [".pi"],
  sensitivePaths: [
    ".env*",
    ".readwise-config.json",
    "credentials*.json",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519",
  ],
  knowledgeDirs: [],
  maxExplicitTargets: 50,
  recoverableDelete: true,
  redaction: {
    enabled: true,
    maxSecretDensity: 0.3,
    scanToolResults: true,
    scanFinalContext: true,
  },
  judge: DEFAULT_JUDGE_CONFIG,
};

const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx",
  ".json", ".yaml", ".yml", ".sql", ".vue", ".svelte", ".sh", ".bash",
  ".zsh", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h",
  ".hpp", ".cs", ".rb", ".php", ".toml", ".env", ".cfg", ".ini",
]);

const PRIVATE_KEY_PATHS = [
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".ssh/*",
  ".gnupg/*",
];

const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)/i;
const REDACTED_MARKER = /^<redacted:[^>]+>$/;
const SAFE_CAPABILITY_DISCOVER = "simplecyon:safe-operation:discover";
const SAFE_CAPABILITY_AVAILABLE = "simplecyon:safe-operation:available";
const SAFE_REDACT_REQUEST = "simplecyon:safe-operation:redact";
const BASH_REDACTION_OWNER_DISCOVER = "simplecyon:bash-redaction-owner:discover";
const BASH_REDACTION_OWNER_AVAILABLE = "simplecyon:bash-redaction-owner:available";
const TOOL_RUNTIME_APPROVAL_END = "simplecyon:tool-runtime:approval-end";
const DEFAULT_BASH_TIMEOUT_SECONDS = 30;

/** macOS terminals reserve Alt for Option input; keep the mode cycle reachable. */
export function interactionModeShortcut(platform = process.platform): "alt+m" | "ctrl+m" {
  return platform === "darwin" ? "ctrl+m" : "alt+m";
}

// The judge completion is resolved lazily from the host's pi-ai at runtime (pi's
// extension loader resolves host modules, as the official custom-compaction
// example relies on). A non-literal specifier keeps tsc from requiring pi-ai at
// package typecheck time; tests inject a fake through __setJudgeCompleteForTests
// and never trigger this import.
const PI_AI_COMPAT_SPEC = "@earendil-works/pi-ai/compat";
async function defaultJudgeComplete(model: unknown, context: unknown, options: unknown): Promise<any> {
  const mod: any = await import(PI_AI_COMPAT_SPEC);
  return mod.completeSimple(model, context, options);
}
let judgeCompleteOverride: ((model: unknown, context: unknown, options: unknown) => Promise<any>) | null = null;
/** Test-only seam: override the judge completion. Pass null to restore the default. */
export function __setJudgeCompleteForTests(impl: typeof judgeCompleteOverride): void {
  judgeCompleteOverride = impl;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const INTERACTION_AUTONOMY: Record<InteractionMode, number> = {
  chat: 0,
  plan: 1,
  "accept-edits": 2,
  auto: 3,
};

function normalizeInteractionMode(value: unknown, fallback: InteractionMode): InteractionMode {
  if (value === "chat" || value === "plan" || value === "accept-edits" || value === "auto") return value;
  // Legacy permissionMode used "ask" for the behavior now named accept-edits.
  if (value === "ask") return "accept-edits";
  return fallback;
}

function requestedInteractionMode(next: Partial<SafeOperationConfig>, fallback: InteractionMode): InteractionMode {
  const legacy = (next as Record<string, unknown>).permissionMode;
  return normalizeInteractionMode(next.interactionMode ?? legacy, fallback);
}

function leastAutonomousMode(a: InteractionMode, b: InteractionMode): InteractionMode {
  return INTERACTION_AUTONOMY[a] <= INTERACTION_AUTONOMY[b] ? a : b;
}

function mergeConfig(base: SafeOperationConfig, next: Partial<SafeOperationConfig>): SafeOperationConfig {
  return {
    ...base,
    ...next,
    version: 1,
    mode: next.mode === "strict" ? "strict" : base.mode,
    interactionMode: requestedInteractionMode(next, base.interactionMode),
    judge: normalizeJudgeConfig(next.judge, base.judge),
    protectedPaths: unique([...base.protectedPaths, ...(next.protectedPaths ?? [])]),
    noDeletePaths: unique([...base.noDeletePaths, ...(next.noDeletePaths ?? [])]),
    sensitivePaths: unique([...base.sensitivePaths, ...(next.sensitivePaths ?? [])]),
    knowledgeDirs: unique([...base.knowledgeDirs, ...(next.knowledgeDirs ?? [])]),
    maxExplicitTargets:
      typeof next.maxExplicitTargets === "number" && next.maxExplicitTargets > 0
        ? Math.floor(next.maxExplicitTargets)
        : base.maxExplicitTargets,
    recoverableDelete:
      typeof next.recoverableDelete === "boolean"
        ? next.recoverableDelete
        : base.recoverableDelete,
    redaction: {
      ...base.redaction,
      ...(next.redaction ?? {}),
    },
  };
}

function readConfigFile(filePath: string): Partial<SafeOperationConfig> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadConfig(cwd: string, projectTrusted: boolean): SafeOperationConfig {
  let config = { ...DEFAULT_CONFIG, redaction: { ...DEFAULT_CONFIG.redaction }, judge: { ...DEFAULT_CONFIG.judge } };
  const globalConfig = readConfigFile(path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "safe-operation.json"));
  if (globalConfig) config = mergeConfig(config, globalConfig);
  if (projectTrusted) {
    const projectConfig = readConfigFile(path.join(cwd, CONFIG_DIR_NAME, "safe-operation.json"));
    if (projectConfig) {
      const baseline = config;
      const merged = mergeConfig(config, projectConfig);
      // A trusted project may add stricter policy, but it cannot switch off the
      // user's egress boundary or raise destructive-operation limits.
      config = {
        ...merged,
        // A trusted project may only reduce the user's execution autonomy.
        interactionMode: leastAutonomousMode(baseline.interactionMode, merged.interactionMode),
        maxExplicitTargets: Math.min(baseline.maxExplicitTargets, merged.maxExplicitTargets),
        redaction: {
          ...merged.redaction,
          enabled: baseline.redaction.enabled,
          scanToolResults: baseline.redaction.scanToolResults,
          scanFinalContext: baseline.redaction.scanFinalContext,
          maxSecretDensity: Math.min(
            baseline.redaction.maxSecretDensity,
            merged.redaction.maxSecretDensity,
          ),
        },
        // Judge identity and budget are pinned to the user's baseline: a project
        // may only raise friction (enable auditSafeOps, tighten onFailure to
        // "block"), never redirect the audit to a project-chosen judge model.
        judge: {
          ...merged.judge,
          provider: baseline.judge.provider,
          model: baseline.judge.model,
          maxTokens: baseline.judge.maxTokens,
          timeoutMs: baseline.judge.timeoutMs,
          reasoning: baseline.judge.reasoning,
          auditSafeOps: baseline.judge.auditSafeOps || merged.judge.auditSafeOps,
          onFailure: merged.judge.onFailure === "block" ? "block" : baseline.judge.onFailure,
        },
      };
    }
  }
  return config;
}

function globalConfigFilePath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "safe-operation.json");
}

/**
 * Read-modify-write the user-level (global) config, preserving unknown keys.
 * Used by the /permission-mode and /judge-model commands. Writing the global
 * file raises the user baseline deliberately: these commands are invoked by
 * the user in the TUI, equivalent to editing the file by hand, so this does
 * not bypass the project-trust clamp.
 */
function persistGlobalConfig(mutate: (raw: Record<string, unknown>) => void): boolean {
  try {
    const file = globalConfigFilePath();
    let raw: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    }
    mutate(raw);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizeRelative(pattern);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`(?:^|/)${escaped}(?:$|/)`, process.platform === "win32" ? "i" : "");
}

function matchesPathPattern(relativePath: string, patterns: string[]): string | null {
  const normalized = normalizeRelative(relativePath);
  const basename = path.posix.basename(normalized);
  for (const pattern of patterns) {
    const matcher = globRegex(pattern);
    if (matcher.test(normalized) || matcher.test(basename)) return pattern;
  }
  return null;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveRealTarget(targetPath: string, cwd: string): string {
  const absolute = path.resolve(cwd, targetPath);
  let existing = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...suffix);
  } catch {
    return absolute;
  }
}

function fileKind(absolute: string): FileKind {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

function isCodeFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
    basename === ".env" ||
    basename === "dockerfile" ||
    basename === "makefile" ||
    basename === "justfile";
}

function underNamedDir(relativePath: string, dirs: string[]): string | null {
  const normalized = normalizeRelative(relativePath);
  for (const dir of dirs) {
    const candidate = normalizeRelative(dir);
    if (normalized === candidate || normalized.startsWith(`${candidate}/`)) return dir;
  }
  return null;
}

function shellBasename(value: string): string {
  return value.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? value.toLowerCase();
}

/**
 * Tokenizer for deliberately simple commands. Complex shell syntax is rejected
 * before this function is used.
 */
function tokenizeSimple(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1] ?? "";
      if (/\s|['"\\]/.test(next)) {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote || escaped) throw new Error("Unclosed quote or escape in command");
  if (current) tokens.push(current);
  return tokens;
}

function shellComplexity(command: string): { compound: boolean; dynamic: boolean } {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let compound = false;
  let dynamic = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const next = command[index + 1] ?? "";
    if (char === ";" || char === "|" || char === "\n" || (char === "&" && next === "&")) {
      compound = true;
    }
    if (
      char === "`" ||
      (char === "$" && (next === "(" || /[A-Za-z_{]/.test(next))) ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      /\%[A-Za-z_][A-Za-z0-9_]*\%/.test(command.slice(index))
    ) {
      dynamic = true;
    }
  }
  return { compound, dynamic };
}

function hasDeleteIntent(command: string): boolean {
  return (
    /(?:^|[;&|(\s])(?:rm|unlink|rmdir|del|erase)(?:\.exe)?\b/i.test(command) ||
    /\bRemove-Item\b/i.test(command) ||
    /\bfind\b[\s\S]*\s-delete\b/i.test(command) ||
    /\bgit\b[^;&|\n]*\bclean\b/i.test(command)
  );
}

function parseDelete(command: string): DeleteParse {
  if (/\bfind\b[\s\S]*\s-delete\b/i.test(command)) {
    return { kind: "generated", commandName: "find -delete", targets: [] };
  }
  if (/\bgit\b[^;&|\n]*\bclean\b/i.test(command)) {
    return { kind: "git-clean", commandName: "git clean", targets: [] };
  }

  const tokens = tokenizeSimple(command);
  const commandIndex = tokens.findIndex((token) =>
    ["rm", "unlink", "rmdir", "del", "del.exe", "erase", "remove-item"].includes(shellBasename(token))
  );
  if (commandIndex < 0) return { kind: "generated", commandName: "delete", targets: [] };

  const commandName = shellBasename(tokens[commandIndex]);
  const targets: string[] = [];
  let optionsEnded = false;
  for (const token of tokens.slice(commandIndex + 1)) {
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token.startsWith("-") || token.startsWith("/"))) {
      // POSIX absolute paths are targets, while Windows /S-style values are flags.
      if (token.startsWith("/") && token.length > 2 && !/^\/[A-Za-z]$/.test(token)) targets.push(token);
      continue;
    }
    targets.push(token);
  }
  return { kind: "files", commandName, targets };
}

async function gitClassFor(pi: ExtensionAPI, cwd: string, absolute: string): Promise<GitClass> {
  if (!isInside(cwd, absolute)) return "outside";
  const relative = path.relative(cwd, absolute);
  try {
    const tracked = await pi.exec("git", ["ls-files", "--error-unmatch", "--", relative]);
    if (tracked.code === 0) return "tracked";
    const ignored = await pi.exec("git", ["check-ignore", "-q", "--", relative]);
    if (ignored.code === 0) return "ignored";
  } catch {
    // A non-git directory is treated as untracked for safety display.
  }
  return "untracked";
}

async function inspectTargets(
  pi: ExtensionAPI,
  cwd: string,
  config: SafeOperationConfig,
  targets: string[],
): Promise<InspectedTarget[]> {
  const root = fs.existsSync(cwd) ? fs.realpathSync.native(cwd) : path.resolve(cwd);
  const inspected: InspectedTarget[] = [];
  for (const requested of targets) {
    const absolute = path.resolve(root, requested);
    const resolved = resolveRealTarget(requested, root);
    const relative = isInside(root, absolute)
      ? normalizeRelative(path.relative(root, absolute) || ".")
      : absolute;
    const realRelative = isInside(root, resolved)
      ? normalizeRelative(path.relative(root, resolved) || ".")
      : resolved;
    inspected.push({
      requested,
      absolute,
      relative,
      realRelative,
      kind: fileKind(absolute),
      gitClass: await gitClassFor(pi, root, absolute),
      exists: fs.existsSync(absolute),
      protected:
        matchesPathPattern(relative, config.protectedPaths) ??
        matchesPathPattern(realRelative, config.protectedPaths),
      noDelete:
        matchesPathPattern(relative, config.noDeletePaths) ??
        matchesPathPattern(realRelative, config.noDeletePaths),
    });
  }
  return inspected;
}

function targetLines(targets: InspectedTarget[]): string {
  return targets.map((target) =>
    `  - ${target.requested} [${target.kind}; ${target.gitClass}${target.protected ? `; protected:${target.protected}` : ""}]`
  ).join("\n");
}

function readableTargetLines(targets: InspectedTarget[]): string[] {
  const kindLabels: Record<FileKind, string> = {
    file: "文件",
    directory: "目录",
    symlink: "符号链接",
    other: "其他类型",
    missing: "不存在",
  };
  const gitLabels: Record<GitClass, string> = {
    tracked: "已被 Git 跟踪",
    ignored: "被 Git 忽略",
    untracked: "未被 Git 跟踪",
    outside: "位于 Git 仓库外",
  };
  return targets.map((target) =>
    `${target.requested} — ${kindLabels[target.kind]}，${gitLabels[target.gitClass]}`
  );
}

function mixedTargetReason(targets: InspectedTarget[]): string | null {
  const kinds = new Set(targets.map((target) => target.kind === "directory" ? "directory" : "non-directory"));
  if (kinds.size > 1) return "Deletion mixes files and directories. Split them into separate operations.";
  const gitClasses = new Set(targets.map((target) => target.gitClass === "tracked" ? "tracked" : "other"));
  if (gitClasses.size > 1) return "Deletion mixes tracked and non-tracked targets. Split them into separate operations.";
  return null;
}

function dangerousCommandReasons(command: string): string[] {
  const rules: Array<[RegExp, string]> = [
    [/\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:--force(?:-with-lease)?|-f)\b/i, "force push rewrites remote history"],
    [/\bgit\b[^;&|\n]*\breset\s+--hard\b/i, "git reset --hard discards work"],
    [/\bgit\b[^;&|\n]*\b(?:checkout\s+--|restore\b)/i, "git restore/checkout may discard work"],
    [/\bgit\b[^;&|\n]*\bbranch\s+-D\b/i, "forced branch deletion"],
    [/\bsudo\b/i, "privilege escalation"],
    [/\b(?:chmod|chown)\b[^;&|\n]*(?:-R|--recursive)\b/i, "recursive permission or ownership change"],
    [/\bdd\s+if=/i, "raw disk operation"],
    [/\bmkfs(?:\.|\s)/i, "filesystem creation destroys existing data"],
    [/\bformat\s+[A-Z]:/i, "drive formatting"],
    [/\b(?:npm|pnpm|yarn|brew|pip|apt|dnf)\b[^;&|\n]*\b(?:uninstall|remove|purge)\b/i, "package removal"],
  ];
  return rules.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
}

function readableRisk(reason: string): string {
  const known: Record<string, string> = {
    "force push rewrites remote history":
      "会改写远端分支历史；其他人的提交可能消失，现有拉取记录也可能需要手动修复。",
    "git reset --hard discards work":
      "会丢弃工作区和暂存区中尚未提交的修改，通常无法自动恢复。",
    "git restore/checkout may discard work":
      "会用 Git 中的版本覆盖当前文件，未提交内容可能丢失。",
    "forced branch deletion":
      "会强制删除本地分支；尚未合并或未推送的提交可能失去常规入口。",
    "privilege escalation":
      "会以更高系统权限执行；影响可能超出当前项目，并修改系统级文件。",
    "recursive permission or ownership change":
      "会递归修改目录下所有内容的权限或所有者，可能导致应用无法读写。",
    "raw disk operation":
      "会直接写入磁盘或设备，目标选择错误可能破坏大量数据。",
    "filesystem creation destroys existing data":
      "会创建新文件系统，目标设备上的现有数据会被清除。",
    "drive formatting":
      "会格式化整个磁盘分区，分区中的数据将被清除。",
    "package removal":
      "会卸载软件包，依赖它的命令、项目或系统功能可能立即失效。",
    "strict mode requires approval for write/edit":
      "当前启用了严格模式，任何文件写入或编辑都必须由你确认。",
    "strict mode requires approval for mutating Bash":
      "当前启用了严格模式，这条命令会修改文件或项目状态。",
    "target already has uncommitted changes":
      "目标文件已有未提交修改；继续编辑会叠加变化，之后更难区分或撤销。",
  };
  if (known[reason]) return known[reason];
  if (reason.startsWith("protected path: ")) {
    return `目标属于受保护路径 ${reason.slice("protected path: ".length)}，修改可能破坏安全配置或项目元数据。`;
  }
  if (reason.startsWith("mutation references protected path: ")) {
    return `命令涉及受保护路径 ${reason.slice("mutation references protected path: ".length)}，可能破坏安全配置或项目元数据。`;
  }
  if (reason.startsWith("code output inside vault knowledge directory: ")) {
    return `将代码写入知识库目录 ${reason.slice("code output inside vault knowledge directory: ".length)}，会混淆文档与代码产物。`;
  }
  if (reason.startsWith("code mutation references vault knowledge directory: ")) {
    return `命令会在知识库目录 ${reason.slice("code mutation references vault knowledge directory: ".length)} 修改代码文件。`;
  }
  if (reason.startsWith("overwrite existing ")) {
    return "会覆盖一个已存在且未被 Git 正常跟踪的文件，旧内容可能无法从版本历史恢复。";
  }
  return reason;
}

function operationCopyForReasons(reasons: string[]): Pick<ApprovalCopy, "action" | "worthWhen" | "saferChoice"> {
  if (reasons.includes("force push rewrites remote history")) {
    return {
      action: "强制推送 Git 分支，并改写远端提交历史。",
      worthWhen: "你明确需要让远端历史与本地历史一致，并确认协作者不会依赖当前远端提交。",
      saferChoice: "优先使用普通 git push；必须改写历史时，优先使用 --force-with-lease 并先确认远端最新状态。",
    };
  }
  if (reasons.includes("git reset --hard discards work")) {
    return {
      action: "把工作区和暂存区强制重置到指定 Git 提交。",
      worthWhen: "你确认所有未提交修改都不再需要，或已经另行备份。",
      saferChoice: "先查看 git status 和 git diff；需要保留内容时先提交或创建补丁。",
    };
  }
  if (reasons.includes("git restore/checkout may discard work")) {
    return {
      action: "用 Git 中的版本覆盖当前文件内容。",
      worthWhen: "你确认当前未提交内容可以丢弃，且目标版本就是需要恢复的版本。",
      saferChoice: "先查看 git diff；只恢复明确文件，并先保存仍有价值的修改。",
    };
  }
  if (reasons.includes("forced branch deletion")) {
    return {
      action: "强制删除一个本地 Git 分支。",
      worthWhen: "你确认该分支的提交已经合并、推送，或确定不再需要。",
      saferChoice: "先使用 git branch -d；它会拒绝删除尚未合并的分支。",
    };
  }
  if (reasons.includes("package removal")) {
    return {
      action: "从当前环境卸载一个或多个软件包。",
      worthWhen: "你确认这些软件包不再被项目、命令或系统功能依赖。",
      saferChoice: "先确认依赖关系和安装范围；不确定时取消并查看包管理器的依赖信息。",
    };
  }
  if (reasons.some((reason) => ["raw disk operation", "filesystem creation destroys existing data", "drive formatting"].includes(reason))) {
    return {
      action: "直接修改磁盘、设备或文件系统。",
      worthWhen: "你已核对设备标识，并确认目标介质上的数据可以被覆盖。",
      saferChoice: "先停止并再次核对设备路径、容量和备份；不要凭名称猜测目标磁盘。",
    };
  }
  if (reasons.includes("privilege escalation")) {
    return {
      action: "以管理员权限执行一条系统级命令。",
      worthWhen: "当前任务确实需要系统权限，且你理解命令对项目外文件的影响。",
      saferChoice: "优先使用不需要 sudo 的项目级方案；不确定影响范围时取消。",
    };
  }
  return {
    action: "执行一条会修改文件、权限或项目状态的命令。",
    worthWhen: "它与当前任务目标一致，并且下面列出的影响范围和风险都在你的预期内。",
    saferChoice: "不确定时先取消，要求查看 diff、预览结果或进一步缩小操作范围。",
  };
}

function looksLikeMutatingBash(command: string): boolean {
  return (
    /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|chmod|chown|truncate|tee)\b/m.test(command) ||
    /(?:^|[;&|]\s*)(?:sed\s+-[^\s]*i|perl\s+-[^\s]*i)\b/m.test(command) ||
    /(^|[^<>])>{1,2}\s*\S/m.test(command)
  );
}

function mentionedProtectedPath(command: string, config: SafeOperationConfig): string | null {
  const normalized = normalizeRelative(command);
  return config.protectedPaths.find((candidate) =>
    normalized.includes(normalizeRelative(candidate))
  ) ?? null;
}

function mentionedCodeInKnowledgeDir(command: string, config: SafeOperationConfig): string | null {
  const normalized = normalizeRelative(command);
  for (const dir of config.knowledgeDirs) {
    const prefix = `${normalizeRelative(dir)}/`;
    const index = normalized.indexOf(prefix);
    if (index < 0) continue;
    const tail = normalized.slice(index);
    if ([...CODE_EXTENSIONS].some((extension) => tail.includes(extension))) return dir;
  }
  return null;
}

function sensitivePath(filePath: string, config: SafeOperationConfig): string | null {
  return matchesPathPattern(normalizeRelative(filePath), config.sensitivePaths);
}

function privateKeyPath(filePath: string): string | null {
  return matchesPathPattern(normalizeRelative(filePath), PRIVATE_KEY_PATHS);
}

function commandSummary(command: string): string {
  return `Command (complete):\n${command}`;
}

function approvalMessage(copy: ApprovalCopy): string {
  const sections = [
    `准备执行\n  ${copy.action}`,
    `只有在以下情况才值得继续\n  ${copy.worthWhen}`,
    `你需要知道的风险\n${copy.risks.map((risk) => `  • ${risk}`).join("\n")}`,
  ];
  if (copy.impact?.length) {
    sections.push(`影响对象\n${copy.impact.map((item) => `  • ${item}`).join("\n")}`);
  }
  if (copy.saferChoice) {
    sections.push(`更安全的选择\n  ${copy.saferChoice}`);
  }
  if (copy.technicalDetails) {
    sections.push(`技术详情（仅供核对）\n${copy.technicalDetails}`);
  }
  return sections.join("\n\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function (pi: ExtensionAPI) {
  let root = process.cwd();
  const packageRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  let config = { ...DEFAULT_CONFIG, redaction: { ...DEFAULT_CONFIG.redaction } };
  let sessionKey = crypto.randomBytes(32);
  let redactedTotal = 0;
  let blockedTotal = 0;
  let approvedTotal = 0;
  let autoApprovedTotal = 0;
  let judgeAnnounced = false;
  let externalBashRedactionOwner = false;
  let standaloneBashRegistered = false;

  const announceCapability = () => {
    pi.events.emit(SAFE_CAPABILITY_AVAILABLE, {
      owner: "@simplecyon/pi-safe-operation",
      protocolVersion: 1,
      redactsToolResults: true,
    });
  };
  pi.events.on(SAFE_CAPABILITY_DISCOVER, announceCapability);
  announceCapability();
  pi.events.on(BASH_REDACTION_OWNER_AVAILABLE, () => {
    externalBashRedactionOwner = true;
  });
  pi.events.emit(BASH_REDACTION_OWNER_DISCOVER, {});

  function audit(action: string, data: Record<string, unknown>): void {
    try {
      pi.appendEntry("pi-safe-operation", {
        timestamp: new Date().toISOString(),
        action,
        ...data,
      });
    } catch {
      // The extension loader test runtime intentionally stubs persistence.
    }
  }

  function marker(kind: string, secret: string): string {
    const digest = crypto.createHmac("sha256", sessionKey).update(secret).digest("hex").slice(0, 6);
    return `<redacted:${kind}#${digest}>`;
  }

  function redactText(input: string): RedactionResult {
    if (!config.redaction.enabled || !input) {
      return { text: input, count: 0, redactedCharacters: 0, kinds: new Set() };
    }
    if (
      input.startsWith("data:image/") ||
      input.startsWith("data:audio/") ||
      (input.length > 100_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(input.slice(0, 4096)))
    ) {
      return { text: input, count: 0, redactedCharacters: 0, kinds: new Set() };
    }

    let text = input;
    let count = 0;
    let redactedCharacters = 0;
    const kinds = new Set<string>();
    const hide = (kind: string, secret: string): string => {
      if (!secret || REDACTED_MARKER.test(secret)) return secret;
      count += 1;
      redactedCharacters += secret.length;
      kinds.add(kind);
      return marker(kind, secret);
    };

    text = text.replace(
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
      (secret) => hide("private-key", secret),
    );
    text = text.replace(
      /((?:"|')?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|secret|token|authorization)(?:"|')?\s*:\s*(?:"|'))([^"'\r\n]+)(["'])/gi,
      (_match, prefix, secret, suffix) => `${prefix}${hide("credential", secret)}${suffix}`,
    );
    text = text.replace(
      /(\b(?:ACCESS_TOKEN|REFRESH_TOKEN|API_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN|AUTHORIZATION)\b\s*=\s*)([^\s\r\n]+)/gi,
      (_match, prefix, secret) => `${prefix}${hide("credential", secret.replace(/^['"]|['"]$/g, ""))}`,
    );
    text = text.replace(
      /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
      (_match, prefix, secret) => `${prefix}${hide("authorization", secret)}`,
    );
    text = text.replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      (secret) => hide("jwt", secret),
    );
    text = text.replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
      (secret) => hide("token", secret),
    );
    text = text.replace(
      /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/g,
      (_match, prefix, secret, suffix) => `${prefix}${hide("url-password", secret)}${suffix}`,
    );

    for (const [name, value] of Object.entries(process.env)) {
      if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
      if (!text.includes(value)) continue;
      text = text.split(value).join(hide("environment", value));
    }

    const density = input.length === 0 ? 0 : redactedCharacters / input.length;
    if (count > 1 && density > config.redaction.maxSecretDensity) {
      const summary = [...kinds].sort().join(",") || "secret";
      return {
        text: `[pi-safe-operation blocked secret-heavy output: ${count} occurrence(s), kinds=${summary}]`,
        count,
        redactedCharacters: input.length,
        kinds,
      };
    }
    return { text, count, redactedCharacters, kinds };
  }

  function sanitizeUnknown(value: unknown, seen = new WeakSet<object>()): { value: unknown; count: number; kinds: Set<string> } {
    if (typeof value === "string") {
      const redacted = redactText(value);
      return { value: redacted.text, count: redacted.count, kinds: redacted.kinds };
    }
    if (value === null || typeof value !== "object") {
      return { value, count: 0, kinds: new Set() };
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return { value, count: 0, kinds: new Set() };
    }
    if (seen.has(value)) {
      return { value, count: 0, kinds: new Set() };
    }
    seen.add(value);

    let count = 0;
    const kinds = new Set<string>();
    const mergeKinds = (incoming: Set<string>) => incoming.forEach((kind) => kinds.add(kind));
    if (Array.isArray(value)) {
      const next = value.map((entry) => {
        const sanitized = sanitizeUnknown(entry, seen);
        count += sanitized.count;
        mergeKinds(sanitized.kinds);
        return sanitized.value;
      });
      return { value: next, count, kinds };
    }

    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (
        key === "data" &&
        typeof entry === "string" &&
        (record.type === "image" || record.type === "audio" || record.encoding === "base64")
      ) {
        next[key] = entry;
        continue;
      }
      const sanitized = sanitizeUnknown(entry, seen);
      next[key] = sanitized.value;
      count += sanitized.count;
      mergeKinds(sanitized.kinds);
    }
    return { value: next, count, kinds };
  }

  function sanitizeBashPayload(payload: unknown, phase: "stream" | "final"): unknown {
    try {
      const sanitized = sanitizeUnknown(payload);
      if (sanitized.count > 0) {
        redactedTotal += sanitized.count;
        audit(`redacted-bash-${phase}`, {
          count: sanitized.count,
          kinds: [...sanitized.kinds].sort(),
        });
      }
      return sanitized.value;
    } catch {
      blockedTotal += 1;
      return {
        content: [{
          type: "text" as const,
          text: "[pi-safe-operation blocked Bash output because redaction failed]",
        }],
        details: { redacted: true, reason: "redaction-failed" },
      };
    }
  }

  pi.events.on(SAFE_REDACT_REQUEST, (request: unknown) => {
    if (!request || typeof request !== "object") return;
    const payload = request as { value?: unknown; phase?: unknown };
    const phase = payload.phase === "stream" ? "stream" : "final";
    payload.value = sanitizeBashPayload(payload.value, phase);
  });

  function registerStandaloneBash(): void {
    if (externalBashRedactionOwner || standaloneBashRegistered) return;
    const builtinBash = createBashToolDefinition(process.cwd());
    const originalPrepare = builtinBash.prepareArguments;
    pi.registerTool({
      ...builtinBash,
      prepareArguments(args) {
        const prepared = originalPrepare ? originalPrepare(args) : args;
        if (!prepared || typeof prepared !== "object") return prepared as any;
        const input = prepared as Record<string, unknown>;
        if (typeof input.timeout === "number") return prepared as any;
        return { ...input, timeout: DEFAULT_BASH_TIMEOUT_SECONDS } as any;
      },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const safeUpdate = onUpdate
          ? (partial: unknown) => onUpdate(sanitizeBashPayload(partial, "stream") as any)
          : undefined;
        const result = await builtinBash.execute(toolCallId, params, signal, safeUpdate, ctx);
        return sanitizeBashPayload(result, "final") as any;
      },
    });
    standaloneBashRegistered = true;
  }

  async function interactiveConfirm(
    ctx: any,
    title: string,
    message: string,
    auditData: Record<string, unknown>,
    runtime: { toolCallId: string; toolName: string },
  ): Promise<boolean> {
    if (!ctx.hasUI) {
      blockedTotal += 1;
      audit("blocked-no-ui", auditData);
      return false;
    }
    const startedAt = Date.now();
    try {
      const ok = await ctx.ui.confirm(title, message);
      if (ok) {
        approvedTotal += 1;
        audit("approved", auditData);
      } else {
        blockedTotal += 1;
        audit("declined", auditData);
      }
      return ok;
    } finally {
      pi.events.emit(TOOL_RUNTIME_APPROVAL_END, {
        toolCallId: runtime.toolCallId,
        toolName: runtime.toolName,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  }

  // Adjudication seam: deterministic hard blocks run before this point.
  // Accept-edits asks the user about flagged operations. Auto sends them to the
  // judge, which either allows the operation or returns constraints to the main
  // Agent for a safer re-plan; technical operation risk never becomes a popup.
  async function adjudicate(
    ctx: any,
    title: string,
    message: string,
    auditData: Record<string, unknown>,
    runtime: { toolCallId: string; toolName: string },
    declineReason: string,
    event: any,
  ): Promise<true | string> {
    if (planMode.isPlanningPhase()) {
      blockedTotal += 1;
      audit("blocked-plan-phase", auditData);
      return declineReason;
    }
    if (config.interactionMode === "auto") {
      return judgeAdjudicate({
        ctx,
        judgeConfig: config.judge,
        request: judgeRequestFromEvent(event, auditData, (text) => redactText(text).text),
        title,
        message,
        declineReason,
        auditData,
        deps: {
          complete: (model, context, options) =>
            (judgeCompleteOverride ?? defaultJudgeComplete)(model, context, options),
          redact: (text) => redactText(text).text,
          audit,
          confirmInteractively: (confirmTitle, confirmMessage) =>
            interactiveConfirm(ctx, confirmTitle, confirmMessage, auditData, runtime),
          countApproved: () => {
            approvedTotal += 1;
            autoApprovedTotal += 1;
            pi.events.emit(SAFE_DECISION_EVENT, {
              toolCallId: runtime.toolCallId,
              decision: "auto-approved",
            });
            updateInteractionModeStatus(ctx);
          },
          countBlocked: () => {
            blockedTotal += 1;
          },
          announce: (judgeId) => {
            if (judgeAnnounced) return;
            judgeAnnounced = true;
            ctx.ui?.notify?.(`[pi-safe-operation] auto 模式裁判模型: ${judgeId}`, "info");
          },
        },
      });
    }
    return (await interactiveConfirm(ctx, title, message, auditData, runtime)) ? true : declineReason;
  }

  function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
  }

  function formatFooterCwd(cwd: string): string {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return cwd;
    const relative = path.relative(path.resolve(home), path.resolve(cwd));
    const insideHome = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return insideHome ? (relative === "" ? "~" : `~${path.sep}${relative}`) : cwd;
  }

  let permissionFooterInstalled = false;

  function installPermissionFooter(ctx: any): void {
    if (permissionFooterInstalled || ctx.mode !== "tui" || typeof ctx.ui?.setFooter !== "function") return;
    permissionFooterInstalled = true;
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const branch = footerData.getGitBranch();
          let cwd = formatFooterCwd(ctx.sessionManager.getCwd());
          if (branch) cwd += ` (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName?.();
          if (sessionName) cwd += ` • ${sessionName}`;

          const permission = theme.fg("accent", `mode: ${config.interactionMode}`);
          const cwdWidth = visibleWidth(cwd);
          const permissionWidth = visibleWidth(permission);
          const firstLine = cwdWidth + permissionWidth + 2 <= width
            ? theme.fg("dim", cwd) + " ".repeat(width - cwdWidth - permissionWidth) + permission
            : truncateToWidth(theme.fg("dim", cwd), Math.max(0, width - permissionWidth - 1), theme.fg("dim", "...")) + " " + permission;

          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;
          let latestCacheHitRate: number | undefined;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message") continue;
            const usage = (entry.message as any).usage;
            if (!usage) continue;
            input += usage.input ?? 0;
            output += usage.output ?? 0;
            cacheRead += usage.cacheRead ?? 0;
            cacheWrite += usage.cacheWrite ?? 0;
            cost += usage.cost?.total ?? 0;
            const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
            if (promptTokens > 0) latestCacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
          }
          const contextUsage = ctx.getContextUsage?.();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercent = contextUsage?.percent;
          const contextText = contextPercent === null || contextPercent === undefined
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
          const statsParts = [
            input && `↑${formatTokens(input)}`,
            output && `↓${formatTokens(output)}`,
            cacheRead && `R${formatTokens(cacheRead)}`,
            cacheWrite && `W${formatTokens(cacheWrite)}`,
            latestCacheHitRate !== undefined && `CH${latestCacheHitRate.toFixed(1)}%`,
            cost && `$${cost.toFixed(3)}`,
            contextPercent !== null && contextPercent !== undefined && contextPercent > 90
              ? theme.fg("error", contextText)
              : contextPercent !== null && contextPercent !== undefined && contextPercent > 70
                ? theme.fg("warning", contextText)
                : contextText,
          ].filter(Boolean);
          const stats = statsParts.join(" ");
          const model = ctx.model?.id || "no-model";
          let modelText = ctx.model?.reasoning
            ? `${model} • ${ctx.thinkingLevel || "off"}`
            : model;
          const availableProviders = typeof ctx.modelRegistry?.getAvailable === "function"
            ? new Set(ctx.modelRegistry.getAvailable().map((item: any) => item.provider)).size
            : 1;
          if (availableProviders > 1 && ctx.model) modelText = `(${ctx.model.provider}) ${modelText}`;
          const statsWidth = visibleWidth(stats);
          const modelWidth = visibleWidth(modelText);
          const secondLine = statsWidth + modelWidth + 2 <= width
            ? theme.fg("dim", stats) + " ".repeat(width - statsWidth - modelWidth) + theme.fg("dim", modelText)
            : theme.fg("dim", truncateToWidth(stats, Math.max(0, width - modelWidth - 1), "...")) + " " + theme.fg("dim", modelText);

          const extensionStatuses = [...footerData.getExtensionStatuses().entries()]
            .filter(([key]: [string, string]) => key !== "interaction-mode")
            .sort(([a]: [string, string], [b]: [string, string]) => a.localeCompare(b))
            .map(([, text]: [string, string]) => text.replace(/[\\r\\n\\t]/g, " ").replace(/ +/g, " ").trim());
          return extensionStatuses.length > 0
            ? [firstLine, secondLine, truncateToWidth(extensionStatuses.join(" "), width, theme.fg("dim", "..."))]
            : [firstLine, secondLine];
        },
      };
    });
  }

  function updateInteractionModeStatus(ctx: any): void {
    if (!ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;
    const text = config.interactionMode === "auto"
      ? `mode: auto · auto ✓${autoApprovedTotal}`
      : `mode: ${config.interactionMode}`;
    ctx.ui.setStatus(
      "interaction-mode",
      typeof ctx.ui.theme?.fg === "function" ? ctx.ui.theme.fg("accent", text) : text,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    root = ctx.cwd;
    sessionKey = crypto.randomBytes(32);
    redactedTotal = 0;
    blockedTotal = 0;
    approvedTotal = 0;
    autoApprovedTotal = 0;
    config = loadConfig(root, ctx.isProjectTrusted());
    judgeAnnounced = false;
    permissionFooterInstalled = false;
    installPermissionFooter(ctx);
    updateInteractionModeStatus(ctx);
    registerStandaloneBash();
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (config.interactionMode === "chat" && !planMode.isPlanningPhase()) {
        blockedTotal += 1;
        audit("blocked-chat-mode", { tool: event.toolName });
        return {
          block: true,
          reason: "Chat mode is active: no tools or state changes are available. Switch to plan, accept-edits, or auto mode before acting.",
        };
      }

      if (event.toolName === "read" && isToolCallEventType("read", event)) {
        const filePath = event.input.path ?? "";
        const keyPattern = privateKeyPath(filePath);
        if (keyPattern) {
          blockedTotal += 1;
          audit("blocked-private-key-read", { tool: "read", path: filePath, pattern: keyPattern });
          return {
            block: true,
            reason: `Reading private key material is blocked by pi-safe-operation: ${filePath}`,
          };
        }
        // Other sensitive files may be read because tool_result is redacted before model context.
        return;
      }

      if (
        planMode.isPlanningPhase() &&
        (event.toolName === "write" || event.toolName === "edit" || event.toolName === "safe_delete")
      ) {
        blockedTotal += 1;
        audit("blocked-plan-phase", { tool: event.toolName });
        return {
          block: true,
          reason:
            "Plan mode is active (planning phase): file changes and deletions are disabled until the plan is approved. " +
            "Finish the plan and let the user approve it, or ask the user to run /plan to exit plan mode.",
        };
      }

      if (
        (event.toolName === "write" && isToolCallEventType("write", event)) ||
        (event.toolName === "edit" && isToolCallEventType("edit", event))
      ) {
        const filePath = String((event.input as { path?: string }).path ?? "");
        if (!filePath) return;
        const absolute = path.resolve(ctx.cwd, filePath);
        const resolved = resolveRealTarget(filePath, ctx.cwd);
        const relative = isInside(ctx.cwd, absolute) ? normalizeRelative(path.relative(ctx.cwd, absolute)) : absolute;
        const realRelative = isInside(ctx.cwd, resolved) ? normalizeRelative(path.relative(ctx.cwd, resolved)) : resolved;
        const protectedPattern =
          matchesPathPattern(relative, config.protectedPaths) ??
          matchesPathPattern(realRelative, config.protectedPaths);
        const knowledgeDir = underNamedDir(relative, config.knowledgeDirs);
        const reasons: string[] = [];
        if (config.mode === "strict") reasons.push("strict mode requires approval for write/edit");
        if (protectedPattern) reasons.push(`protected path: ${protectedPattern}`);
        if (knowledgeDir && isCodeFile(absolute)) reasons.push(`code output inside vault knowledge directory: ${knowledgeDir}/`);

        if (event.toolName === "write" && fs.existsSync(absolute)) {
          const gitClass = await gitClassFor(pi, ctx.cwd, absolute);
          if (gitClass !== "tracked") reasons.push(`overwrite existing ${gitClass} target`);
        }
        if (event.toolName === "edit" && isInside(ctx.cwd, absolute)) {
          const status = await pi.exec("git", ["status", "--porcelain", "--", path.relative(ctx.cwd, absolute)]);
          if (status.code === 0 && status.stdout.trim()) reasons.push("target already has uncommitted changes");
        }
        if (reasons.length === 0) {
          if (config.interactionMode === "auto" && config.judge.auditSafeOps) {
            const safeVerdict = await adjudicate(
              ctx,
              "裁判审计：文件修改",
              approvalMessage({
                action: `${event.toolName === "edit" ? "编辑" : "写入"}文件 ${filePath}（未被确定性规则标记，按 judge.auditSafeOps 送审）。`,
                worthWhen: "这是当前任务需要修改的文件。",
                risks: ["纵深防御审计：该修改未被规则标记，由裁判模型复核。"],
                impact: [filePath],
                saferChoice: "不确定时先取消。",
              }),
              { tool: event.toolName, path: filePath, reasons: [] },
              { toolCallId: event.toolCallId, toolName: event.toolName },
              "Write blocked by pi-safe-operation (judge.auditSafeOps)",
              event,
            );
            if (safeVerdict !== true) return { block: true, reason: safeVerdict };
          }
          return;
        }

        const writeAction =
          event.toolName === "edit"
            ? `编辑文件 ${filePath}。`
            : fs.existsSync(absolute)
              ? `覆盖文件 ${filePath}。`
              : `创建文件 ${filePath}。`;
        const ok = await adjudicate(ctx, "确认文件修改", approvalMessage({
          action: writeAction,
          worthWhen: "这是当前任务需要修改的文件，并且现有内容已保留、可恢复或确定不再需要。",
          risks: unique(reasons).map(readableRisk),
          impact: [filePath],
          saferChoice: "不确定时先取消，查看现有内容和 diff，或先备份目标文件。",
        }), {
          tool: event.toolName,
          path: filePath,
          reasons,
        }, { toolCallId: event.toolCallId, toolName: event.toolName },
          `Write blocked by pi-safe-operation: ${reasons.join("; ")}`, event);
        if (ok !== true) return { block: true, reason: ok };
        return;
      }

      if (!(event.toolName === "bash" && isToolCallEventType("bash", event))) return;
      const command = event.input.command ?? "";
      if (!command) return;

      if (planMode.isPlanningPhase() && !isSafePlanCommand(command)) {
        blockedTotal += 1;
        audit("blocked-plan-phase-command", { tool: "bash", command: redactText(command).text });
        return {
          block: true,
          reason:
            "Plan mode is active (planning phase): command is not on the read-only allowlist. " +
            "Finish the plan and let the user approve it, or ask the user to run /plan to exit plan mode.\n\n" +
            commandSummary(command),
        };
      }

      if (hasDeleteIntent(command)) {
        const complexity = shellComplexity(command);
        if (complexity.compound || complexity.dynamic) {
          blockedTotal += 1;
          const reason =
            "Deletion must be a standalone command with explicit targets. " +
            "Compound commands, pipelines, variables, command substitutions, and globs are blocked.\n\n" +
            commandSummary(command);
          audit("blocked-complex-delete", { tool: "bash", command: redactText(command).text });
          return { block: true, reason };
        }

        const parsed = parseDelete(command);
        if (parsed.kind === "generated") {
          blockedTotal += 1;
          return {
            block: true,
            reason: `Generated deletion is blocked; resolve exact targets first.\n\n${commandSummary(command)}`,
          };
        }
        if (parsed.kind === "git-clean") {
          const ok = await adjudicate(
            ctx,
            "确认清理 Git 未跟踪文件",
            approvalMessage({
              action: "永久删除当前仓库中被 git clean 匹配到的未跟踪文件。",
              worthWhen: "你明确要清理这些未跟踪文件，并且已经用 git clean -nd 检查过将被删除的清单。",
              risks: [
                "未跟踪文件不在 Git 历史中，删除后通常无法恢复。",
                "命令中的范围选项可能一次匹配多个目录和文件。",
              ],
              impact: ["当前 Git 仓库中由该命令匹配的未跟踪文件"],
              saferChoice: "先运行 git clean -nd 只预览，不执行删除。",
              technicalDetails: redactText(command).text,
            }),
            { tool: "bash", operation: "git-clean", command: redactText(command).text },
            { toolCallId: event.toolCallId, toolName: event.toolName },
            "git clean blocked by pi-safe-operation",
            event,
          );
          if (ok !== true) return { block: true, reason: ok };
          return;
        }
        if (parsed.targets.length === 0) {
          return { block: true, reason: `Deletion has no explicit targets.\n\n${commandSummary(command)}` };
        }
        if (parsed.targets.length > config.maxExplicitTargets) {
          return {
            block: true,
            reason:
              `Deletion has ${parsed.targets.length} targets; maximum is ${config.maxExplicitTargets}. ` +
              `Use safe_delete with reviewed batches.`,
          };
        }

        const targets = await inspectTargets(pi, ctx.cwd, config, parsed.targets);
        const broad = targets.find((target) =>
          target.relative === "." || target.absolute === path.parse(target.absolute).root
        );
        if (broad) {
          return { block: true, reason: `Broad deletion target is blocked: ${broad.requested}` };
        }
        const forbidden = targets.find((target) => target.noDelete || target.protected);
        if (forbidden) {
          return {
            block: true,
            reason:
              `Deletion targets protected path ${forbidden.requested}` +
              ` (${forbidden.noDelete ?? forbidden.protected}).\n\nTargets:\n${targetLines(targets)}`,
          };
        }
        const mixed = mixedTargetReason(targets);
        if (mixed) {
          return {
            block: true,
            reason: `${mixed}\n\nTargets:\n${targetLines(targets)}\n\n${commandSummary(command)}`,
          };
        }
        if (config.mode === "strict") {
          blockedTotal += 1;
          audit("blocked-strict-raw-delete", {
            targets: targets.map((target) => target.relative),
          });
          return {
            block: true,
            reason:
              `Strict mode requires safe_delete for project deletion.\n\nTargets:\n${targetLines(targets)}`,
          };
        }
        const ok = await adjudicate(
          ctx,
          "确认永久删除",
          approvalMessage({
            action: `永久删除 ${targets.length} 个目标，不经过 safe-operation 回收站。`,
            worthWhen: "你逐项确认这些目标都不再需要，并接受它们可能无法恢复。",
            risks: unique([
              "这是永久删除，safe_restore 无法恢复这些目标。",
              targets.some((target) => target.gitClass !== "tracked")
                ? "未被 Git 跟踪或被 Git 忽略的内容可能没有任何版本可找回。"
                : "已被 Git 跟踪的文件可从提交恢复，但其中未提交的修改仍会丢失。",
            ]),
            impact: readableTargetLines(targets),
            saferChoice: "改用 safe_delete，把目标先移动到可恢复回收站。",
            technicalDetails: redactText(command).text,
          }),
          { tool: "bash", operation: "delete", targets: targets.map((target) => target.relative) },
          { toolCallId: event.toolCallId, toolName: event.toolName },
          "Permanent deletion blocked by pi-safe-operation",
          event,
        );
        if (ok !== true) return { block: true, reason: ok };
        return;
      }

      const reasons = dangerousCommandReasons(command);
      if (looksLikeMutatingBash(command)) {
        if (config.mode === "strict") reasons.push("strict mode requires approval for mutating Bash");
        const protectedPattern = mentionedProtectedPath(command, config);
        const knowledgeDir = mentionedCodeInKnowledgeDir(command, config);
        if (protectedPattern) reasons.push(`mutation references protected path: ${protectedPattern}`);
        if (knowledgeDir) reasons.push(`code mutation references vault knowledge directory: ${knowledgeDir}/`);
      }
      if (reasons.length === 0) {
        if (config.interactionMode === "auto" && config.judge.auditSafeOps && looksLikeMutatingBash(command)) {
          const safeVerdict = await adjudicate(
            ctx,
            "裁判审计：变更命令",
            approvalMessage({
              action: "执行变更类 Bash 命令（未被确定性规则标记，按 judge.auditSafeOps 送审）。",
              worthWhen: "这是当前任务需要的命令。",
              risks: ["纵深防御审计：该命令未被规则标记，由裁判模型复核。"],
              saferChoice: "不确定时先取消。",
              technicalDetails: redactText(command).text,
            }),
            { tool: "bash", operation: "mutation-audit", reasons: [], command: redactText(command).text },
            { toolCallId: event.toolCallId, toolName: event.toolName },
            "Command blocked by pi-safe-operation (judge.auditSafeOps)",
            event,
          );
          if (safeVerdict !== true) return { block: true, reason: safeVerdict };
        }
        return;
      }
      const uniqueReasons = unique(reasons);
      const operationCopy = operationCopyForReasons(uniqueReasons);
      const ok = await adjudicate(
        ctx,
        "确认高风险操作",
        approvalMessage({
          ...operationCopy,
          risks: uniqueReasons.map(readableRisk),
          technicalDetails: redactText(command).text,
        }),
        { tool: "bash", operation: "dangerous-command", reasons: uniqueReasons, command: redactText(command).text },
        { toolCallId: event.toolCallId, toolName: event.toolName },
        `Command blocked by pi-safe-operation: ${uniqueReasons.join("; ")}`,
        event,
      );
      if (ok !== true) return { block: true, reason: ok };
    } catch (error) {
      blockedTotal += 1;
      const reason = error instanceof Error ? error.message : safeStringify(error);
      audit("guard-error", { tool: event.toolName, reason: redactText(reason).text });
      return { block: true, reason: `pi-safe-operation failed closed: ${redactText(reason).text}` };
    }
  });

  pi.on("tool_result", async (event) => {
    if (!config.redaction.enabled || !config.redaction.scanToolResults) return;
    try {
      let count = 0;
      const kinds = new Set<string>();
      const content = event.content.map((item) => {
        if (item.type !== "text") return item;
        const redacted = redactText(item.text);
        count += redacted.count;
        redacted.kinds.forEach((kind) => kinds.add(kind));
        return { ...item, text: redacted.text };
      });
      const sanitizedDetails = sanitizeUnknown(event.details);
      count += sanitizedDetails.count;
      sanitizedDetails.kinds.forEach((kind) => kinds.add(kind));
      if (count === 0) return;
      redactedTotal += count;
      audit("redacted-tool-result", {
        tool: event.toolName,
        count,
        kinds: [...kinds].sort(),
      });
      return {
        content,
        details: sanitizedDetails.value,
      };
    } catch {
      blockedTotal += 1;
      return {
        content: [{
          type: "text" as const,
          text: "[pi-safe-operation blocked tool output because redaction failed]",
        }],
        details: { redacted: true, reason: "redaction-failed" },
        isError: true,
      };
    }
  });

  pi.on("context", async (event) => {
    if (!config.redaction.enabled || !config.redaction.scanFinalContext) return;
    try {
      const sanitized = sanitizeUnknown(event.messages);
      if (sanitized.count === 0) return;
      redactedTotal += sanitized.count;
      audit("redacted-context", { count: sanitized.count, kinds: [...sanitized.kinds].sort() });
      return { messages: sanitized.value as typeof event.messages };
    } catch {
      // Replacing the entire context would destroy the session. The final provider
      // egress hook remains fail-closed for any payload it cannot sanitize.
      return;
    }
  });

  pi.on("before_provider_request", async (event) => {
    if (!config.redaction.enabled || !config.redaction.scanFinalContext) return;
    try {
      const sanitized = sanitizeUnknown(event.payload);
      if (sanitized.count === 0) return;
      redactedTotal += sanitized.count;
      audit("redacted-provider-payload", { count: sanitized.count, kinds: [...sanitized.kinds].sort() });
      return sanitized.value;
    } catch {
      // A replacement payload with no messages prevents raw data egress. Providers
      // may reject it, which is preferable to transmitting unsanitized secrets.
      return {
        error: "pi-safe-operation blocked provider payload because redaction failed",
        messages: [],
      };
    }
  });

  pi.registerTool({
    name: "safe_delete",
    label: "Safe Delete",
    description:
      "Recoverably remove explicit project paths by moving them into the project trash with a manifest. " +
      "Use only for targets the user explicitly authorized. Mixed file/directory or tracked/non-tracked batches are rejected.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
      reason: Type.String({
        minLength: 1,
        maxLength: 240,
        description: "The user's authorization or concrete reason for deleting exactly these targets.",
      }),
    }, { additionalProperties: false }),
    promptSnippet: "safe_delete(paths: string[], reason: string) → recoverably move explicit project targets to trash",
    promptGuidelines: [
      NON_CIRCUMVENTION_GUIDELINE,
      "Use safe_delete instead of rm when deleting project files or directories.",
      "safe_delete authorization is target-scoped: include only paths explicitly named by the user or unambiguously inside the requested class.",
      "Never add opportunistic cleanup targets to safe_delete; use a separate proposed action for unrelated targets.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = fs.existsSync(ctx.cwd) ? fs.realpathSync.native(ctx.cwd) : path.resolve(ctx.cwd);
      if (!config.recoverableDelete) {
        blockedTotal += 1;
        return {
          content: [{
            type: "text" as const,
            text: "safe_delete is disabled by the active user policy.",
          }],
          details: { moved: [] },
        };
      }
      const paths = unique(params.paths.map((value) => value.trim()).filter(Boolean));
      if (paths.length === 0) {
        return {
          content: [{ type: "text" as const, text: "safe_delete requires at least one explicit path." }],
          details: { moved: [] },
        };
      }
      if (paths.length > config.maxExplicitTargets) {
        return {
          content: [{
            type: "text" as const,
            text: `safe_delete blocked ${paths.length} targets; maximum is ${config.maxExplicitTargets}.`,
          }],
          details: { moved: [] },
        };
      }

      const targets = await inspectTargets(pi, cwd, config, paths);
      const invalid = targets.find((target) =>
        !target.exists ||
        !isInside(cwd, target.absolute) ||
        target.relative === "." ||
        target.relative.startsWith(".trash/") ||
        target.noDelete ||
        target.protected
      );
      if (invalid) {
        const reason = !invalid.exists
          ? "target does not exist"
          : !isInside(cwd, invalid.absolute)
            ? "target is outside the project"
            : invalid.noDelete || invalid.protected
              ? `protected by ${invalid.noDelete ?? invalid.protected}`
              : "target is too broad or already in trash";
        blockedTotal += 1;
        audit("safe-delete-blocked", { target: invalid.relative, reason });
        return {
          content: [{ type: "text" as const, text: `safe_delete blocked ${invalid.requested}: ${reason}` }],
          details: { moved: [] },
        };
      }
      const mixed = mixedTargetReason(targets);
      if (mixed) {
        blockedTotal += 1;
        return {
          content: [{ type: "text" as const, text: `${mixed}\n\nTargets:\n${targetLines(targets)}` }],
          details: { moved: [] },
        };
      }
      if (!ctx.hasUI) {
        blockedTotal += 1;
        return {
          content: [{ type: "text" as const, text: `safe_delete requires interactive approval.\n\nTargets:\n${targetLines(targets)}` }],
          details: { moved: [] },
        };
      }

      const approved = await ctx.ui.confirm(
        "确认移动到可恢复回收站",
        approvalMessage({
          action: `把 ${targets.length} 个目标从原位置移动到 safe-operation 回收站。`,
          worthWhen: `你确实要从当前工作区移除这些目标。Agent 提供的原因是：${redactText(params.reason).text}`,
          risks: [
            "目标会立即从原路径消失，依赖这些路径的任务可能停止工作。",
            "内容仍保存在项目的 .trash 目录中并占用磁盘空间。",
          ],
          impact: readableTargetLines(targets),
          saferChoice: "这是比永久删除更安全的方式；确认清单无误后可继续，之后可用 safe_restore 恢复。",
        }),
      );
      if (!approved) {
        blockedTotal += 1;
        audit("safe-delete-declined", { targets: targets.map((target) => target.relative) });
        return {
          content: [{ type: "text" as const, text: "safe_delete was declined by the user." }],
          details: { moved: [] },
        };
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trashRoot = path.join(cwd, ".trash", "pi-safe-operation", stamp);
      const moved: Array<{ original: string; trashed: string }> = [];
      try {
        fs.mkdirSync(trashRoot, { recursive: true });
        for (const target of targets) {
          const destination = path.join(trashRoot, target.relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.renameSync(target.absolute, destination);
          moved.push({ original: target.relative, trashed: normalizeRelative(path.relative(cwd, destination)) });
        }
        const manifest = {
          version: 1,
          timestamp: new Date().toISOString(),
          reason: redactText(params.reason).text,
          targets: moved,
        };
        fs.writeFileSync(path.join(trashRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const item of [...moved].reverse()) {
          try {
            const original = path.join(cwd, item.original);
            const trashed = path.join(cwd, item.trashed);
            fs.mkdirSync(path.dirname(original), { recursive: true });
            fs.renameSync(trashed, original);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        blockedTotal += 1;
        audit("safe-delete-failed", {
          count: moved.length,
          error: redactText(message).text,
          rollbackErrors: rollbackErrors.map((value) => redactText(value).text),
        });
        return {
          content: [{
            type: "text" as const,
            text:
              `safe_delete failed and attempted rollback: ${redactText(message).text}` +
              (rollbackErrors.length ? `\nRollback errors: ${rollbackErrors.length}` : ""),
          }],
          details: { moved: [], rolledBack: rollbackErrors.length === 0 },
        };
      }

      approvedTotal += 1;
      audit("safe-delete-complete", { count: moved.length, targets: moved.map((item) => item.original) });
      return {
        content: [{
          type: "text" as const,
          text:
            `Moved ${moved.length} target(s) to recoverable trash.\n` +
            `Manifest: ${normalizeRelative(path.relative(cwd, path.join(trashRoot, "manifest.json")))}`,
        }],
        details: { moved, trashRoot: normalizeRelative(path.relative(cwd, trashRoot)) },
      };
    },
  });

  pi.registerTool({
    name: "safe_trash_list",
    label: "Safe Trash List",
    description:
      "List recoverable pi-safe-operation trash manifests and their remaining restorable targets. This tool is read-only.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    promptSnippet: "safe_trash_list(limit?: number) → list recoverable deletion manifests",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = fs.existsSync(ctx.cwd) ? fs.realpathSync.native(ctx.cwd) : path.resolve(ctx.cwd);
      const trashBase = path.join(cwd, ".trash", "pi-safe-operation");
      const limit = params.limit ?? 20;
      if (!fs.existsSync(trashBase)) {
        return {
          content: [{ type: "text" as const, text: "No pi-safe-operation trash manifests found." }],
          details: { manifests: [] },
        };
      }

      const manifests: Array<{
        manifest: string;
        timestamp: string;
        reason: string;
        total: number;
        remaining: number;
      }> = [];
      for (const entry of fs.readdirSync(trashBase, { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name))) {
        const manifestPath = path.join(trashBase, entry.name, "manifest.json");
        try {
          if (fs.lstatSync(manifestPath).isSymbolicLink()) continue;
          if (!isInside(fs.realpathSync.native(trashBase), fs.realpathSync.native(manifestPath))) continue;
          const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as TrashManifest;
          if (!Array.isArray(parsed.targets)) continue;
          const remaining = parsed.targets.filter((target) => {
            if (typeof target?.trashed !== "string") return false;
            const candidate = path.resolve(cwd, target.trashed);
            return isInside(trashBase, candidate) && fs.existsSync(candidate);
          }).length;
          manifests.push({
            manifest: normalizeRelative(path.relative(cwd, manifestPath)),
            timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : entry.name,
            reason: redactText(typeof parsed.reason === "string" ? parsed.reason : "").text,
            total: parsed.targets.length,
            remaining,
          });
          if (manifests.length >= limit) break;
        } catch {
          // Ignore malformed entries here; safe_restore validates a selected
          // manifest strictly and fails closed.
        }
      }
      if (manifests.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No valid pi-safe-operation trash manifests found." }],
          details: { manifests: [] },
        };
      }
      const text = manifests.map((item) =>
        [
          item.manifest,
          `  timestamp: ${item.timestamp}`,
          `  remaining: ${item.remaining}/${item.total}`,
          `  reason: ${item.reason || "(not recorded)"}`,
        ].join("\n")
      ).join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { manifests },
      };
    },
  });

  pi.registerTool({
    name: "safe_restore",
    label: "Safe Restore",
    description:
      "Restore all or selected targets from a pi-safe-operation manifest. Existing destinations, protected paths, malformed manifests, and non-interactive execution are blocked.",
    parameters: Type.Object({
      manifest: Type.String({
        minLength: 1,
        description: "Project-relative manifest path returned by safe_trash_list or safe_delete.",
      }),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 50,
        description: "Optional original project-relative paths to restore. Omit to restore every remaining target.",
      })),
      reason: Type.String({
        minLength: 1,
        maxLength: 240,
        description: "Why these exact targets should be restored.",
      }),
    }, { additionalProperties: false }),
    promptSnippet:
      "safe_restore(manifest: string, paths?: string[], reason: string) → restore recoverable targets after approval",
    promptGuidelines: [
      "Call safe_trash_list first when the manifest is not already known.",
      "Never overwrite an existing destination during restore.",
      "Restore only paths explicitly requested by the user; omit paths only when the user asked to restore the whole deletion transaction.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = fs.existsSync(ctx.cwd) ? fs.realpathSync.native(ctx.cwd) : path.resolve(ctx.cwd);
      const trashBase = path.join(cwd, ".trash", "pi-safe-operation");
      const manifestPath = path.resolve(cwd, params.manifest);
      const fail = (message: string) => {
        blockedTotal += 1;
        audit("safe-restore-blocked", { manifest: params.manifest, reason: message });
        return {
          content: [{ type: "text" as const, text: `safe_restore blocked: ${message}` }],
          details: { restored: [] },
        };
      };

      if (
        path.basename(manifestPath) !== "manifest.json" ||
        !isInside(trashBase, manifestPath) ||
        !fs.existsSync(manifestPath)
      ) {
        return fail("manifest must be an existing manifest.json inside .trash/pi-safe-operation/");
      }
      const realTrashBase = fs.realpathSync.native(trashBase);
      if (
        fs.lstatSync(manifestPath).isSymbolicLink() ||
        !isInside(realTrashBase, fs.realpathSync.native(manifestPath))
      ) {
        return fail("manifest symlinks and paths escaping the managed trash are not allowed");
      }

      let manifest: TrashManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as TrashManifest;
      } catch {
        return fail("manifest is not valid JSON");
      }
      if (
        manifest.version !== 1 ||
        !Array.isArray(manifest.targets) ||
        manifest.targets.some((target) =>
          !target ||
          typeof target.original !== "string" ||
          typeof target.trashed !== "string"
        )
      ) {
        return fail("manifest schema is invalid");
      }

      const requested = params.paths
        ? new Set(unique(params.paths.map((value) => normalizeRelative(value.trim())).filter(Boolean)))
        : null;
      const known = new Set(manifest.targets.map((target) => normalizeRelative(target.original)));
      if (requested) {
        const unknown = [...requested].find((target) => !known.has(target));
        if (unknown) return fail(`requested path is not present in the manifest: ${unknown}`);
      }

      const selected = manifest.targets.filter((target) => {
        if (requested) return requested.has(normalizeRelative(target.original));
        return fs.existsSync(path.resolve(cwd, target.trashed));
      });
      if (selected.length === 0) {
        return fail(requested ? "no manifest targets were selected" : "manifest has no remaining targets");
      }
      if (selected.length > config.maxExplicitTargets) {
        return fail(`selected ${selected.length} targets; maximum is ${config.maxExplicitTargets}`);
      }

      const restorations: Array<{
        original: string;
        trashed: string;
        originalAbsolute: string;
        trashedAbsolute: string;
      }> = [];
      for (const target of selected) {
        const original = normalizeRelative(target.original);
        const trashed = normalizeRelative(target.trashed);
        const originalAbsolute = path.resolve(cwd, original);
        const trashedAbsolute = path.resolve(cwd, trashed);
        const resolvedOriginal = resolveRealTarget(original, cwd);
        if (
          !original ||
          original === "." ||
          path.isAbsolute(target.original) ||
          !isInside(cwd, originalAbsolute) ||
          !isInside(cwd, resolvedOriginal)
        ) {
          return fail(`manifest original path is unsafe: ${target.original}`);
        }
        if (!isInside(trashBase, trashedAbsolute)) {
          return fail(`manifest trash path escapes the managed trash: ${target.trashed}`);
        }
        if (!fs.existsSync(trashedAbsolute)) {
          return fail(`trashed source no longer exists: ${trashed}`);
        }
        if (!isInside(realTrashBase, fs.realpathSync.native(path.dirname(trashedAbsolute)))) {
          return fail(`manifest trash parent escapes the managed trash: ${target.trashed}`);
        }
        if (fs.existsSync(originalAbsolute)) {
          return fail(`restore destination already exists: ${original}`);
        }
        const protectedPattern =
          matchesPathPattern(original, config.noDeletePaths) ??
          matchesPathPattern(original, config.protectedPaths);
        if (protectedPattern) {
          return fail(`restore destination is protected by ${protectedPattern}: ${original}`);
        }
        restorations.push({ original, trashed, originalAbsolute, trashedAbsolute });
      }

      if (!ctx.hasUI) {
        return fail("interactive approval is required");
      }
      const approved = await ctx.ui.confirm(
        "确认恢复回收站内容",
        approvalMessage({
          action: `把 ${restorations.length} 个目标从 safe-operation 回收站恢复到原路径。`,
          worthWhen: `你需要这些目标重新出现在工作区。Agent 提供的原因是：${redactText(params.reason).text}`,
          risks: [
            "恢复后文件会重新参与当前项目，可能改变构建、搜索或运行结果。",
            "恢复操作会移动回收站内容；成功后原回收站位置将不再保留该副本。",
          ],
          impact: restorations.map((item) => `${item.trashed} → ${item.original}`),
          saferChoice: "目标路径已检查为不存在；仍不确定时先取消并查看 manifest 与当前工作区状态。",
        }),
      );
      if (!approved) {
        blockedTotal += 1;
        audit("safe-restore-declined", {
          manifest: normalizeRelative(path.relative(cwd, manifestPath)),
          targets: restorations.map((item) => item.original),
        });
        return {
          content: [{ type: "text" as const, text: "safe_restore was declined by the user." }],
          details: { restored: [] },
        };
      }

      const restored: TrashManifestTarget[] = [];
      try {
        for (const item of restorations) {
          fs.mkdirSync(path.dirname(item.originalAbsolute), { recursive: true });
          fs.renameSync(item.trashedAbsolute, item.originalAbsolute);
          restored.push({ original: item.original, trashed: item.trashed });
        }
        manifest.restorations = [
          ...(Array.isArray(manifest.restorations) ? manifest.restorations : []),
          {
            timestamp: new Date().toISOString(),
            reason: redactText(params.reason).text,
            targets: restored,
          },
        ];
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const item of [...restored].reverse()) {
          try {
            const originalAbsolute = path.resolve(cwd, item.original);
            const trashedAbsolute = path.resolve(cwd, item.trashed);
            fs.mkdirSync(path.dirname(trashedAbsolute), { recursive: true });
            fs.renameSync(originalAbsolute, trashedAbsolute);
          } catch (rollbackError) {
            rollbackErrors.push(
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            );
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        blockedTotal += 1;
        audit("safe-restore-failed", {
          error: redactText(message).text,
          rollbackErrors: rollbackErrors.map((value) => redactText(value).text),
        });
        return {
          content: [{
            type: "text" as const,
            text:
              `safe_restore failed and attempted rollback: ${redactText(message).text}` +
              (rollbackErrors.length ? `\nRollback errors: ${rollbackErrors.length}` : ""),
          }],
          details: { restored: [], rolledBack: rollbackErrors.length === 0 },
        };
      }

      approvedTotal += 1;
      audit("safe-restore-complete", {
        manifest: normalizeRelative(path.relative(cwd, manifestPath)),
        targets: restored.map((item) => item.original),
      });
      return {
        content: [{
          type: "text" as const,
          text: `Restored ${restored.length} target(s) from recoverable trash.`,
        }],
        details: { restored },
      };
    },
  });

  // A session holds config in memory, while /mode and /judge-model intentionally
  // persist at user scope. Refresh before a user-triggered decision so a second
  // live session observes changes made by the first without a restart.
  function refreshRuntimeConfig(ctx: any): void {
    config = loadConfig(ctx.cwd ?? root, ctx.isProjectTrusted?.() ?? true);
  }

  // Shared by /mode, the legacy /permission-mode alias, and the mode shortcut. The global
  // config persists the user-visible interaction mode; legacy permissionMode is
  // read on startup but never written again.
  async function applyInteractionMode(mode: InteractionMode, ctx: any): Promise<void> {
    if (!persistGlobalConfig((raw) => {
      raw.interactionMode = mode;
      delete raw.permissionMode;
    })) {
      ctx.ui.notify(`写入全局配置失败: ${globalConfigFilePath()}`, "error");
      return;
    }
    config.interactionMode = mode;
    if (mode === "plan") planMode.enterPlanning(ctx);
    else if (planMode.isPlanningPhase()) planMode.exitPlanning(ctx);
    updateInteractionModeStatus(ctx);
    const judge = config.judge.provider && config.judge.model
      ? `${config.judge.provider}/${config.judge.model}`
      : "default";
    ctx.ui.notify(`mode: ${mode}${mode === "auto" ? ` · judge: ${judge}` : ""}`, "info");
  }

  const INTERACTION_MODE_CYCLE: InteractionMode[] = ["chat", "plan", "accept-edits", "auto"];
  const modeShortcut = interactionModeShortcut();
  pi.registerShortcut(modeShortcut, {
    description: "Cycle interaction mode (chat → plan → accept-edits → auto)",
    handler: async (ctx) => {
      refreshRuntimeConfig(ctx);
      const index = INTERACTION_MODE_CYCLE.indexOf(config.interactionMode);
      const next = INTERACTION_MODE_CYCLE[(index + 1) % INTERACTION_MODE_CYCLE.length];
      await applyInteractionMode(next, ctx);
    },
  });

  async function handleModeCommand(args: unknown, ctx: any): Promise<void> {
    const value = typeof args === "string" ? args.trim() : "";
    if (!value) {
      ctx.ui.notify(
        [
          `interaction mode: ${config.interactionMode}`,
          `judge: ${config.judge.provider && config.judge.model ? `${config.judge.provider}/${config.judge.model}` : "内置默认候选（按 modelRegistry + auth 解析）"}`,
          `设置: /mode chat|plan|accept-edits|auto（写入全局配置，本会话即时生效）；${modeShortcut} 循环切换。`,
        ].join("\n"),
        "info",
      );
      return;
    }
    if (value !== "chat" && value !== "plan" && value !== "accept-edits" && value !== "auto") {
      ctx.ui.notify(`未知 interaction mode: ${value}。可选: chat | plan | accept-edits | auto`, "error");
      return;
    }
    await applyInteractionMode(value as InteractionMode, ctx);
  }

  pi.registerCommand("mode", {
    description: "Show or set interaction mode (chat | plan | accept-edits | auto)",
    handler: handleModeCommand,
  });
  pi.registerCommand("permission-mode", {
    description: "Legacy alias for /mode",
    handler: handleModeCommand,
  });

  pi.registerCommand("judge-model", {
    description: "Show or set the auto-mode judge model (<provider>/<model>); persists to the global config",
    handler: async (args, ctx) => {
      refreshRuntimeConfig(ctx);
      const value = typeof args === "string" ? args.trim() : "";
      if (!value) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            [
              config.judge.provider && config.judge.model
                ? `judge: ${config.judge.provider}/${config.judge.model}`
                : "judge: 内置默认候选（按 modelRegistry + auth 解析）",
              `onFailure: ${config.judge.onFailure} · auditSafeOps: ${config.judge.auditSafeOps ? "on" : "off"}`,
              "设置: /judge-model <provider>/<model>（写入全局配置，即时生效）",
            ].join("\n"),
            "info",
          );
          return;
        }
        const registry: any = ctx.modelRegistry;
        try {
          await registry?.refresh?.();
        } catch {
          // Keep the synchronous registry snapshot if a refresh is unavailable.
        }
        let models: any[] = [];
        try {
          const available = typeof registry?.getAvailable === "function"
            ? await registry.getAvailable()
            : [];
          models = Array.isArray(available) ? available : [];
        } catch {
          ctx.ui.notify("无法读取可用模型，未打开 judge selector。请检查 /models 或 provider 登录状态。", "error");
          return;
        }
        const currentJudge = config.judge.provider && config.judge.model
          ? `${config.judge.provider}/${config.judge.model}`
          : undefined;
        const sortedChoices = [...models]
          .map((model: any) => `${model.provider}/${model.id}`)
          .sort((a: string, b: string) => a.localeCompare(b));
        const choices = currentJudge && sortedChoices.includes(currentJudge)
          ? [currentJudge, ...sortedChoices.filter((choice: string) => choice !== currentJudge)]
          : sortedChoices;
        if (choices.length === 0) {
          ctx.ui.notify("没有可用模型，无法配置 judge。请先用 /models 或 /login 配置模型。", "error");
          return;
        }
        const selected = await ctx.ui.select(
          currentJudge ? `Select judge model (current: ${currentJudge})` : "Select judge model (current: default candidates)",
          choices,
        );
        if (!selected) return;
        const slash = selected.indexOf("/");
        if (slash <= 0 || slash === selected.length - 1) return;
        const provider = selected.slice(0, slash);
        const model = selected.slice(slash + 1);
        const found = typeof registry?.find === "function" ? registry.find(provider, model) : undefined;
        if (!found) {
          ctx.ui.notify(`modelRegistry 中找不到 ${selected}，未写入。`, "error");
          return;
        }
        if (!persistGlobalConfig((raw) => {
          const judge = (typeof raw.judge === "object" && raw.judge !== null ? raw.judge : {}) as Record<string, unknown>;
          judge.provider = provider;
          judge.model = model;
          raw.judge = judge;
        })) {
          ctx.ui.notify(`写入全局配置失败: ${globalConfigFilePath()}`, "error");
          return;
        }
        config.judge = { ...config.judge, provider, model };
        ctx.ui.notify(`裁判模型已设为 ${selected}（已写入全局配置，即时生效）。`, "info");
        return;
      }
      const slash = value.indexOf("/");
      if (slash <= 0 || slash === value.length - 1) {
        ctx.ui.notify("格式: /judge-model <provider>/<model>", "error");
        return;
      }
      const provider = value.slice(0, slash);
      const model = value.slice(slash + 1);
      const registry: any = (ctx as any).modelRegistry;
      const found = registry && typeof registry.find === "function" ? registry.find(provider, model) : undefined;
      if (!found) {
        ctx.ui.notify(
          `modelRegistry 中找不到 ${provider}/${model}，未写入。请先用 /models 确认可用的 provider 与模型 id。`,
          "error",
        );
        return;
      }
      if (!persistGlobalConfig((raw) => {
        const judge = (typeof raw.judge === "object" && raw.judge !== null ? raw.judge : {}) as Record<string, unknown>;
        judge.provider = provider;
        judge.model = model;
        raw.judge = judge;
      })) {
        ctx.ui.notify(`写入全局配置失败: ${globalConfigFilePath()}`, "error");
        return;
      }
      config.judge = { ...config.judge, provider, model };
      const authWarning =
        typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(found)
          ? "\n警告：该模型没有已配置凭据，裁判调用会 fail-closed；请先配置 API key。"
          : "";
      ctx.ui.notify(`裁判模型已设为 ${provider}/${model}（已写入全局配置，即时生效）。${authWarning}`, "info");
    },
  });

  pi.registerCommand("safe", {
    description: "Show pi-safe-operation status and session counters",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          `pi-safe-operation: ${config.mode} · mode: ${config.interactionMode}`,
          `root: ${root}`,
          `redacted: ${redactedTotal}`,
          `approved: ${approvedTotal}`,
          `auto-approved: ${autoApprovedTotal}`,
          `blocked/declined: ${blockedTotal}`,
          `recoverable delete: ${config.recoverableDelete ? "enabled" : "disabled"}`,
          `judge: ${config.judge.provider && config.judge.model ? `${config.judge.provider}/${config.judge.model}` : "default candidates"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("safe-update-check", {
    description: "Check whether the installed pi-packages Git source is behind origin/main",
    handler: async (_args, ctx) => {
      if (!fs.existsSync(path.join(packageRepositoryRoot, ".git"))) {
        ctx.ui.notify(
          "pi-safe-operation is not running from a Git package checkout. Use Pi's package manager to check npm updates.",
          "info",
        );
        return;
      }
      const local = await pi.exec("git", ["-C", packageRepositoryRoot, "rev-parse", "HEAD"]);
      if (local.code !== 0 || !local.stdout.trim()) {
        ctx.ui.notify("Unable to read the installed pi-packages commit.", "error");
        return;
      }
      const remote = await pi.exec("git", [
        "-C",
        packageRepositoryRoot,
        "ls-remote",
        "origin",
        "refs/heads/main",
      ]);
      if (remote.code !== 0 || !remote.stdout.trim()) {
        ctx.ui.notify(
          `Unable to check pi-packages origin/main: ${redactText(remote.stderr || "unknown error").text}`,
          "error",
        );
        return;
      }
      const localCommit = local.stdout.trim().split(/\s+/)[0];
      const remoteCommit = remote.stdout.trim().split(/\s+/)[0];
      if (localCommit === remoteCommit) {
        ctx.ui.notify(`pi-packages is current (${localCommit.slice(0, 8)}).`, "info");
        return;
      }
      ctx.ui.notify(
        [
          `pi-packages update available: ${localCommit.slice(0, 8)} -> ${remoteCommit.slice(0, 8)}`,
          "Run:",
          "pi update --extension git:github.com/simplecyon/pi-packages",
        ].join("\n"),
        "warning",
      );
    },
  });

  // Permission-mode runtime (plan-mode state machine). Registered LAST so this
  // package's own session_start (config load) and context (redaction) handlers
  // Keep registration ahead of the plan controller: config must load before it
  // reads interaction mode, and egress redaction remains the first context pass.
  const planMode = setupPermissionMode(pi, {
    getInteractionMode: () => config.interactionMode,
    setInteractionMode: applyInteractionMode,
  });
}
