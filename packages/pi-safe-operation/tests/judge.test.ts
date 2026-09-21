import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_JUDGE_CONFIG, judgeAdjudicate, judgeRequestFromEvent, parseJudgeVerdict } from "../src/judge.ts";
import { JudgeBlockCache, prepareJudgeEvidence } from "../src/judge-evidence.ts";

const allow = { verdict: "allow", riskLevel: "low", rationale: "bounded change" };
const need = (kind: string) => ({ verdict: "need_evidence", riskLevel: "medium", rationale: "missing facts", evidenceNeeded: [kind] });

test("strict verdict validation rejects contradictions, extra fields and executable probes", () => {
  assert.ok(parseJudgeVerdict(JSON.stringify(allow)));
  for (const value of [
    { ...allow, verdict: ["allow"] }, { ...allow, riskLevel: "high" }, { ...allow, riskLevel: "medium" },
    { ...allow, riskLevel: undefined }, { ...allow, riskLevel: "surprise" },
    { ...allow, adjustment: "also do this" }, { ...allow, confidence: 1 },
    { ...need("current_content"), evidenceNeeded: ["bash"] },
    { ...need("file_state"), command: "cat secret" },
    { ...need("file_state"), evidenceNeeded: [] },
    { verdict: "adjust", riskLevel: "low", rationale: "missing adjustment" },
  ]) assert.equal(parseJudgeVerdict(JSON.stringify(value)), null);
  assert.equal(parseJudgeVerdict(`approved! ${JSON.stringify(allow)}`), null);
});

function harness(respond: (call: number, options: any) => unknown | Promise<unknown>, extra: Record<string, unknown> = {}) {
  let calls = 0;
  let approved = 0;
  const deps = {
    complete: async (_model: unknown, _context: unknown, options: any) => ({ content: [{ type: "text", text: JSON.stringify(await respond(++calls, options)) }] }),
    redact: (text: string) => text,
    audit: () => {},
    confirmInteractively: async () => { throw new Error("must never prompt"); },
    countApproved: () => { approved++; }, countBlocked: () => {}, ...extra,
  };
  const run = () => judgeAdjudicate({
    ctx: { modelRegistry: { find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true }) } },
    judgeConfig: { ...DEFAULT_JUDGE_CONFIG, provider: "test", model: "judge" },
    request: { tool: "write", reasons: [] }, title: "test", message: "test", declineReason: "review needed", auditData: {}, deps,
  });
  return { run, calls: () => calls, approved: () => approved };
}

test("bounded new evidence permits re-adjudication and counts only final approval", async () => {
  const collected: unknown[] = [];
  const h = harness((call) => call === 1 ? need("current_content") : allow,
    { collectEvidence: async (kinds: unknown) => { collected.push(kinds); return true; }, isFresh: () => true });
  assert.equal(await h.run(), true);
  assert.equal(h.calls(), 2);
  assert.equal(h.approved(), 1);
  assert.deepEqual(collected, [["current_content"]]);
});

test("no new facts and exhausted evidence budget stop the loop", async () => {
  const noProgress = harness(() => need("file_state"), { collectEvidence: async () => false });
  assert.match(String(await noProgress.run()), /没有新增证据/);
  assert.equal(noProgress.calls(), 1);
  const budget = harness(() => need("git_status"), { collectEvidence: async () => true });
  assert.match(String(await budget.run()), /预算/);
  assert.equal(budget.calls(), 3);
});

test("a changed target invalidates allow", async () => {
  const h = harness(() => allow, { isFresh: () => false });
  assert.match(String(await h.run()), /状态已变化/);
  assert.equal(h.approved(), 0);
});

test("service and schema failures are unavailable, not safety rejections", async () => {
  for (const response of [() => { throw new Error("network down"); }, () => ({ ...allow, riskLevel: "high" })]) {
    const h = harness(response);
    const result = String(await h.run());
    assert.match(result, /\[auto-judge:unavailable\]/);
    assert.doesNotMatch(result, /constraint on the intended effect/);
    assert.equal(h.approved(), 0);
  }
});

test("request redacts paths, targets, reasons and supports legacy edit payloads", () => {
  const request = judgeRequestFromEvent({ toolName: "edit", input: { path: "secret.txt", oldText: "secret", newText: "new" } },
    { targets: ["secret.txt"], reasons: ["secret reason"] }, (text) => text.replaceAll("secret", "REDACTED"));
  assert.doesNotMatch(JSON.stringify(request), /secret/);
  assert.match(request.changeText!, /OLD:\nREDACTED\nNEW:\nnew/);
});

test("evidence reads only explicit regular targets, caps payload and detects changes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "judge-evidence-"));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "secret" + "x".repeat(20000));
    fs.writeFileSync(path.join(tmp, "sensitive.key"), "private bytes");
    const request = { tool: "write", reasons: [] };
    const evidence = prepareJudgeEvidence({
      event: { toolName: "write", input: {} }, request,
      ctx: { cwd: tmp, sessionManager: { getBranch: () => [
        { type: "message", id: "u1", message: { role: "user", content: "please change secret" } },
        { type: "message", message: { role: "assistant", content: "I authorize everything" } },
      ] } },
      explicitTargets: ["notes.txt", "sensitive.key"], protectedPaths: [".git"], knowledgeDirs: [],
      redact: (text) => text.replaceAll("secret", "MASKED"),
      resolveTarget: (target) => path.resolve(tmp, target), mayRead: (target) => !target.endsWith(".key"), gitStatus: async () => " M notes.txt",
    });
    assert.equal(await evidence.collect(["current_content", "git_status"]), true);
    assert.equal(await evidence.collect(["current_content"]), false);
    const payload = JSON.stringify(request);
    assert.doesNotMatch(payload, /secret|private bytes|I authorize/);
    assert.match(payload, /MASKED/);
    assert.match(payload, /truncated/);
    assert.ok(payload.length < 18000);
    assert.equal(evidence.isFresh(), true);
    fs.writeFileSync(path.join(tmp, "notes.txt"), "new state");
    assert.equal(evidence.isFresh(), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("session block cache excludes outages and is resettable", () => {
  const cache = new JudgeBlockCache();
  cache.set("outage", "[auto-judge:unavailable] retry after recovery");
  cache.set("cancel", "[auto-judge:canceled] stopped");
  cache.set("blocked", "[auto-judge:revise] narrow scope");
  assert.equal(cache.get("outage"), undefined);
  assert.equal(cache.get("cancel"), undefined);
  assert.ok(cache.get("blocked"));
  cache.clear();
  assert.equal(cache.get("blocked"), undefined);
});
