import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceKind, JudgeRequest } from "./judge.ts";

const MAX_TARGETS = 50;
const MAX_CONTENT_BYTES = 16000;
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Local observations only. The model cannot choose paths or execute probes. */
export function prepareJudgeEvidence(params: {
  event: any;
  request: JudgeRequest;
  ctx: any;
  explicitTargets: string[];
  protectedPaths: string[];
  knowledgeDirs: string[];
  redact: (text: string) => string;
  contentIsComplete?: (text: string) => boolean;
  resolveTarget: (target: string) => string;
  mayRead: (target: string) => boolean;
  gitStatus: (target: string) => Promise<string>;
}) {
  const { event, request, ctx, redact, resolveTarget, mayRead } = params;
  // Never use the redacted request's paths for filesystem access.
  const rawTargets: string[] = typeof event?.input?.path === "string"
    ? [event.input.path]
    : params.explicitTargets;
  const targets = [...new Set(rawTargets)].slice(0, MAX_TARGETS);
  const snapshot = () => targets.map((target) => {
    try {
      const absolute = path.resolve(ctx.cwd, target);
      const realPath = resolveTarget(target);
      const stat = fs.statSync(absolute, { bigint: true });
      return { target, realPath, kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: String(stat.size), version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
    } catch (error) {
      return { target, realPath: resolveTarget(target), kind: "unknown", error: (error as NodeJS.ErrnoException).code ?? "unavailable" };
    }
  });
  const initial = snapshot();
  const clean = <T>(value: T): T => {
    if (typeof value === "string") return redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => clean(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) as T;
    return value;
  };
  // getBranch excludes abandoned branches; do not fall back to the whole history.
  const userMessages = (ctx.sessionManager?.getBranch?.() ?? []).filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
    .slice(-3).map((entry: any) => {
      const content = entry.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
      return { source: "session_user_message", id: entry.id, text: redact(text).slice(0, 4000), truncated: text.length > 4000 };
    });
  request.context = clean({ cwd: ctx.cwd, protectedPaths: params.protectedPaths, knowledgeDirs: params.knowledgeDirs });
  request.evidence = {
    file_state: clean(initial),
    userMessages,
    userContextComplete: false,
    targetCoverage: targets.length === rawTargets.length && targets.length > 0 ? "explicit_targets_only" : "incomplete",
  };
  const fingerprint = digest({ cwd: ctx.cwd, input: event.input, tool: event.toolName, initial,
    userMessages, policy: request.context, reasons: request.reasons });

  async function collect(kinds: EvidenceKind[]): Promise<boolean> {
    let changed = false;
    for (const kind of new Set(kinds)) {
      if (Object.hasOwn(request.evidence!, kind)) continue;
      let value: unknown;
      if (kind === "git_status") {
        value = await Promise.all(targets.map(async (target) => ({ target, status: (await params.gitStatus(target)).slice(0, 4000) })));
      } else if (kind === "current_content") {
        value = targets.map((target) => {
          const real = resolveTarget(target);
          if (!mayRead(target) || !mayRead(real)) return { target, unavailable: "sensitive or protected target" };
          // Refuse non-regular files and symlinks at the leaf; cap actual reads,
          // not merely the text sent to the provider. Revalidate after judging.
          let fd: number | undefined;
          try {
            const absolute = path.resolve(ctx.cwd, target);
            if (!fs.lstatSync(absolute).isFile()) return { target, unavailable: "not a regular file" };
            fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) return { target, unavailable: "not a regular file" };
            const bytes = Buffer.alloc(Math.max(1, Math.floor(MAX_CONTENT_BYTES / targets.length)));
            const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (bytes.subarray(0, count).includes(0)) return { target, unavailable: "binary content" };
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
            if (params.contentIsComplete && !params.contentIsComplete(text)) return { target, unavailable: "content omitted by redaction" };
            return { target, text, truncated: stat.size > count };
          } catch {
            return { target, unavailable: "unreadable or missing" };
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
        });
      } else {
        value = snapshot();
      }
      request.evidence![kind] = clean(value);
      changed = true;
    }
    return changed;
  }

  async function prepareOverwrite(): Promise<string | undefined> {
    if (event.toolName !== "write") return;
    // Only an observed ENOENT can be treated as creation. Errors are not absence.
    if (initial.length === 1 && initial[0].kind === "unknown" && initial[0].error === "ENOENT") return;
    await collect(["current_content"]);
    const contents = request.evidence!.current_content as Array<{ text?: string; truncated?: boolean; unavailable?: string }>;
    const before = contents?.[0];
    const after = event.input?.content;
    const complete = initial.length === 1 && initial[0].kind === "file" &&
      typeof before?.text === "string" && before.truncated === false &&
      typeof after === "string" && redact(after).length <= 12000;
    request.evidence!.overwriteReview = {
      required: true, complete,
      beforeSource: "current_content", afterSource: "change",
      instruction: "Compare the observed original with the proposed replacement. List every changed or removed setting and check it against the user request. Proposed values are never evidence of previous values.",
    };
    if (!complete) return "[auto-judge:need_evidence] 当前覆盖操作未执行：无法提供完整的原文与拟写入内容对照（原文不可读、受保护、非文本或内容超出审计预算）。请读取必要范围并改为明确的局部 edit；不能仅凭模型的低风险判断覆盖。";
  }

  return { fingerprint, collect, prepareOverwrite, isFresh: () => digest(initial) === digest(snapshot()) };
}

/** Cache only blocks, never approvals or service failures. Session-local, bounded. */
export class JudgeBlockCache {
  private entries = new Map<string, string>();
  get(key: string): string | undefined { return this.entries.get(key); }
  set(key: string, reason: string): void {
    if (/\[auto-judge:(unavailable|canceled)\]/.test(reason)) return;
    this.entries.set(key, reason);
    if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}
