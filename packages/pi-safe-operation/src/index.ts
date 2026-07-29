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
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  protectedPaths: string[];
  noDeletePaths: string[];
  sensitivePaths: string[];
  knowledgeDirs: string[];
  maxExplicitTargets: number;
  recoverableDelete: boolean;
  redaction: RedactionConfig;
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

const DEFAULT_CONFIG: SafeOperationConfig = {
  version: 1,
  mode: "balanced",
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeConfig(base: SafeOperationConfig, next: Partial<SafeOperationConfig>): SafeOperationConfig {
  return {
    ...base,
    ...next,
    version: 1,
    mode: next.mode === "strict" ? "strict" : base.mode,
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
  let config = { ...DEFAULT_CONFIG, redaction: { ...DEFAULT_CONFIG.redaction } };
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
      };
    }
  }
  return config;
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function (pi: ExtensionAPI) {
  let root = process.cwd();
  let config = { ...DEFAULT_CONFIG, redaction: { ...DEFAULT_CONFIG.redaction } };
  let sessionKey = crypto.randomBytes(32);
  let redactedTotal = 0;
  let blockedTotal = 0;
  let approvedTotal = 0;

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

  async function confirmOperation(
    ctx: any,
    title: string,
    message: string,
    auditData: Record<string, unknown>,
  ): Promise<boolean> {
    if (!ctx.hasUI) {
      blockedTotal += 1;
      audit("blocked-no-ui", auditData);
      return false;
    }
    const ok = await ctx.ui.confirm(title, message);
    if (ok) {
      approvedTotal += 1;
      audit("approved", auditData);
    } else {
      blockedTotal += 1;
      audit("declined", auditData);
    }
    return ok;
  }

  pi.on("session_start", async (_event, ctx) => {
    root = ctx.cwd;
    sessionKey = crypto.randomBytes(32);
    redactedTotal = 0;
    blockedTotal = 0;
    approvedTotal = 0;
    config = loadConfig(root, ctx.isProjectTrusted());
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
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
        if (reasons.length === 0) return;

        const message = `Target:\n  ${filePath}\n\nSafety findings:\n${reasons.map((reason) => `  - ${reason}`).join("\n")}\n\nProceed?`;
        const ok = await confirmOperation(ctx, "⚠️ Safe operation gate", message, {
          tool: event.toolName,
          path: filePath,
          reasons,
        });
        if (!ok) return { block: true, reason: `Write blocked by pi-safe-operation: ${reasons.join("; ")}` };
        return;
      }

      if (!(event.toolName === "bash" && isToolCallEventType("bash", event))) return;
      const command = event.input.command ?? "";
      if (!command) return;

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
          const ok = await confirmOperation(
            ctx,
            "⚠️ Git clean",
            `${commandSummary(command)}\n\nGit clean permanently removes untracked files. Execute?`,
            { tool: "bash", operation: "git-clean", command: redactText(command).text },
          );
          if (!ok) return { block: true, reason: "git clean blocked by pi-safe-operation" };
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
        const ok = await confirmOperation(
          ctx,
          "⚠️ Permanent deletion",
          `${commandSummary(command)}\n\nResolved targets:\n${targetLines(targets)}\n\nPrefer safe_delete for recoverability. Execute permanently?`,
          { tool: "bash", operation: "delete", targets: targets.map((target) => target.relative) },
        );
        if (!ok) return { block: true, reason: "Permanent deletion blocked by pi-safe-operation" };
        return;
      }

      const reasons = dangerousCommandReasons(command);
      if (looksLikeMutatingBash(command)) {
        const protectedPattern = mentionedProtectedPath(command, config);
        const knowledgeDir = mentionedCodeInKnowledgeDir(command, config);
        if (protectedPattern) reasons.push(`mutation references protected path: ${protectedPattern}`);
        if (knowledgeDir) reasons.push(`code mutation references vault knowledge directory: ${knowledgeDir}/`);
      }
      if (reasons.length === 0) return;
      const ok = await confirmOperation(
        ctx,
        "⚠️ Safe operation gate",
        `${commandSummary(command)}\n\nSafety findings:\n${unique(reasons).map((reason) => `  - ${reason}`).join("\n")}\n\nExecute?`,
        { tool: "bash", operation: "dangerous-command", reasons: unique(reasons), command: redactText(command).text },
      );
      if (!ok) return { block: true, reason: `Command blocked by pi-safe-operation: ${unique(reasons).join("; ")}` };
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
      "Use safe_delete instead of rm when deleting project files or directories.",
      "safe_delete authorization is target-scoped: include only paths explicitly named by the user or unambiguously inside the requested class.",
      "Never add opportunistic cleanup targets to safe_delete; use a separate proposed action for unrelated targets.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = fs.existsSync(ctx.cwd) ? fs.realpathSync.native(ctx.cwd) : path.resolve(ctx.cwd);
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
        "Move targets to recoverable trash?",
        `Reason:\n  ${redactText(params.reason).text}\n\nExact targets:\n${targetLines(targets)}\n\nContinue?`,
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

  pi.registerCommand("safe", {
    description: "Show pi-safe-operation status and session counters",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          `pi-safe-operation: ${config.mode}`,
          `root: ${root}`,
          `redacted: ${redactedTotal}`,
          `approved: ${approvedTotal}`,
          `blocked/declined: ${blockedTotal}`,
          `recoverable delete: ${config.recoverableDelete ? "enabled" : "disabled"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
