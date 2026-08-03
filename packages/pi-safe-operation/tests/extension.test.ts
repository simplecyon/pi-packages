import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import safeOperation, { __setJudgeCompleteForTests } from "../src/index.ts";

async function loadSafeOperation(cwd: string) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, { definition: any }>();
  const commands = new Map<string, unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "safe_delete"];
  const flags = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const sentMessages: Array<{ message: any; options: unknown }> = [];
  const sentUserMessages: Array<{ content: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, { definition: tool });
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    registerFlag(name: string, spec: { default?: unknown }) {
      flags.set(name, spec?.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerShortcut(key: string, spec: unknown) {
      shortcuts.set(key, spec);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools.splice(0, activeTools.length, ...names);
    },
    sendMessage(message: any, options: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content: string, options: unknown) {
      sentUserMessages.push({ content, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
    },
    async exec(command: string, args: string[]) {
      const result = spawnSync(command, args, { cwd, encoding: "utf8" });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  } as unknown as ExtensionAPI;
  safeOperation(pi);
  return { handlers, tools, commands, entries, pi, emitted, activeTools, flags, shortcuts, sentMessages, sentUserMessages };
}

function baseContext(cwd: string, hasUI = false, sessionEntries: unknown[] = []) {
  return {
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "print",
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "safe-operation-test-session",
      getSessionFile: () => undefined,
      getEntries: () => sessionEntries,
    },
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "modelRegistry stub: no judge models" }),
    },
    ui: {
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      select: async () => undefined,
      editor: async () => undefined,
      setStatus: () => {},
      setWidget: () => {},
      theme: {
        fg: (_color: string, text: string) => text,
        strikethrough: (text: string) => text,
      },
    },
  };
}

test("blocks the real mixed screenshot and node_modules compound deletion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-incident-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    const command =
      "rm -v dropdown.png edit-modal.png .readwise-config.json package-lock.json && rm -rf node_modules/";
    const result = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "incident", input: { command } },
      baseContext(tmp, true),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /standalone command/);
    assert.match(result?.reason ?? "", /node_modules\//);
    assert.match(result?.reason ?? "", /\.readwise-config\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("publishes effect-level non-circumvention guidance without path or command special cases", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-guidance-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const safeDelete = extension.tools.get("safe_delete")?.definition;
    assert.ok(safeDelete);
    const guideline = safeDelete.promptGuidelines.find((value: string) =>
      value.includes("constraint on the intended effect")
    );
    assert.ok(guideline);
    assert.match(guideline, /do not retry, translate, decompose, delegate, or recommend/i);
    assert.match(guideline, /materially narrows the scope or removes the stated risk/i);
    assert.match(guideline, /after a user decline rather than a policy block/i);
    assert.match(guideline, /fresh explicit authorization/i);
    assert.doesNotMatch(guideline, /\brm\b|\.pi/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("announces a redacted tool-result capability for dependent extensions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-capability-"));
  try {
    const extension = await loadSafeOperation(tmp);
    assert.deepEqual(extension.emitted[0], {
      channel: "simplecyon:safe-operation:available",
      data: {
        owner: "@simplecyon/pi-safe-operation",
        protocolVersion: 1,
        redactsToolResults: true,
      },
    });
    extension.pi.events.emit("simplecyon:safe-operation:discover", {});
    assert.equal(
      extension.emitted.filter((event) => event.channel === "simplecyon:safe-operation:available").length,
      2,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("defers the Bash override when another extension owns the redaction bridge", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-bash-owner-"));
  try {
    const extension = await loadSafeOperation(tmp);
    extension.pi.events.emit("simplecyon:bash-redaction-owner:available", {
      owner: "@simplecyon/pi-minimal-tui",
      protocolVersion: 1,
    });
    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp));
    assert.equal(extension.tools.has("bash"), false);

    const secret = ["xoxb", "1234567890", "bridgefixture"].join("-");
    const request = {
      value: { content: [{ type: "text", text: `TOKEN=${secret}` }] },
      phase: "stream",
    };
    extension.pi.events.emit("simplecyon:safe-operation:redact", request);
    assert.doesNotMatch(JSON.stringify(request.value), new RegExp(secret));
    assert.match(JSON.stringify(request.value), /<redacted:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("blocks a standalone batch that mixes files and directories", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-mixed-"));
  try {
    fs.writeFileSync(path.join(tmp, "screenshot.png"), "image");
    fs.mkdirSync(path.join(tmp, "node_modules"));
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);

    const result = await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "mixed",
        input: { command: "rm -rf screenshot.png node_modules" },
      },
      baseContext(tmp),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /mixes files and directories/);
    assert.match(result?.reason ?? "", /screenshot\.png/);
    assert.match(result?.reason ?? "", /node_modules/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("shows every explicit deletion target without command truncation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-preview-"));
  try {
    const names = Array.from({ length: 18 }, (_, index) => `screenshot-${String(index).padStart(2, "0")}.png`);
    for (const name of names) fs.writeFileSync(path.join(tmp, name), "image");
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    let prompt = "";

    const result = await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "preview",
        input: { command: `rm ${names.join(" ")}` },
      },
      {
        ...baseContext(tmp, true),
        ui: {
          confirm: async (_title: string, message: string) => {
            prompt = message;
            return false;
          },
          input: async () => undefined,
          notify: () => {},
        },
      },
    );
    assert.equal(result?.block, true);
    for (const name of names) assert.match(prompt, new RegExp(name.replace(".", "\\.")));
    assert.doesNotMatch(prompt, /…/);
    assert.match(prompt, /准备执行/);
    assert.match(prompt, /只有在以下情况才值得继续/);
    assert.match(prompt, /你需要知道的风险/);
    assert.match(prompt, /影响对象/);
    assert.match(prompt, /更安全的选择/);
    assert.match(prompt, /技术详情（仅供核对）/);
    assert.match(prompt, /safe_delete/);
    assert.doesNotMatch(prompt, /Command \(complete\)|Safety findings|Execute\?/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("explains a force push in decision language before showing the command", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-force-push-copy-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    let title = "";
    let prompt = "";
    const command = "git push --force origin main";

    const result = await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "force-push-copy",
        input: { command },
      },
      {
        ...baseContext(tmp, true),
        ui: {
          confirm: async (nextTitle: string, message: string) => {
            title = nextTitle;
            prompt = message;
            return false;
          },
          input: async () => undefined,
          notify: () => {},
        },
      },
    );

    assert.equal(result?.block, true);
    assert.equal(title, "确认高风险操作");
    assert.match(prompt, /强制推送 Git 分支，并改写远端提交历史/);
    assert.match(prompt, /其他人的提交可能消失/);
    assert.match(prompt, /--force-with-lease/);
    assert.ok(prompt.indexOf("准备执行") < prompt.indexOf(command));
    assert.ok(prompt.indexOf("你需要知道的风险") < prompt.indexOf(command));
    const approvalEvent = extension.emitted.find(
      (event) => event.channel === "simplecyon:tool-runtime:approval-end",
    );
    assert.ok(approvalEvent);
    assert.equal((approvalEvent.data as any).toolCallId, "force-push-copy");
    assert.equal((approvalEvent.data as any).toolName, "bash");
    assert.equal(typeof (approvalEvent.data as any).durationMs, "number");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redacts sensitive tool output and details before model context", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-redact-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_result")?.[0];
    assert.ok(handler);
    const secret = "sk-testvalue1234567890ABCDEFG";

    const result = await handler({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "redact",
      input: { command: "print config" },
      content: [{ type: "text", text: `API_KEY=${secret}\nAuthorization: Bearer ${secret}` }],
      details: { stdout: `token: "${secret}"` },
      isError: false,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /<redacted:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redacts generic structured credentials and keeps a stable session fingerprint", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-structured-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_result")?.[0];
    assert.ok(handler);
    const secret = "generic-readwise-value-without-known-prefix";
    const result = await handler({
      type: "tool_result",
      toolName: "read",
      toolCallId: "structured",
      input: { path: ".readwise-config.json" },
      content: [{
        type: "text",
        text:
          `{"token":"${secret}","backup_token":"${secret}",` +
          `"description":"${"non-sensitive context ".repeat(24)}"}`,
      }],
      details: undefined,
      isError: false,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    const fingerprints = [...serialized.matchAll(/<redacted:credential#([a-f0-9]{6})>/g)]
      .map((match) => match[1]);
    assert.equal(fingerprints.length, 2);
    assert.equal(new Set(fingerprints).size, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("project config cannot disable the redaction boundary", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-policy-"));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({
        redaction: {
          enabled: false,
          scanToolResults: false,
          scanFinalContext: false,
          maxSecretDensity: 1,
        },
      }),
    );
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    const resultHandler = extension.handlers.get("tool_result")?.[0];
    assert.ok(sessionStart);
    assert.ok(resultHandler);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const secret = "sk-projectcannotdisable123456789";
    const result = await resultHandler({
      type: "tool_result",
      toolName: "read",
      toolCallId: "policy",
      input: { path: "config.json" },
      content: [{ type: "text", text: secret }],
      details: undefined,
      isError: false,
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /<redacted:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("strict mode requires safe_delete and gates otherwise ordinary mutations", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-strict-"));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({ mode: "strict" }),
    );
    fs.writeFileSync(path.join(tmp, "victim.txt"), "keep");
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(sessionStart);
    assert.ok(toolCall);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));

    const deletion = await toolCall(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "strict-delete",
        input: { command: "rm victim.txt" },
      },
      {
        ...baseContext(tmp, true),
        ui: {
          confirm: async () => true,
          input: async () => undefined,
          notify: () => {},
        },
      },
    );
    assert.equal(deletion?.block, true);
    assert.match(deletion?.reason ?? "", /Strict mode requires safe_delete/);

    const write = await toolCall(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "strict-write",
        input: { path: "new.txt", content: "new" },
      },
      baseContext(tmp),
    );
    assert.equal(write?.block, true);
    assert.match(write?.reason ?? "", /strict mode/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("applies a final context egress redaction pass", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-context-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("context")?.[0];
    assert.ok(handler);
    const secret = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const result = await handler({
      type: "context",
      messages: [{ role: "toolResult", content: [{ type: "text", text: secret }] }],
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /<redacted:token#/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("blocks private key reads before execution", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-key-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    const result = await handler(
      { type: "tool_call", toolName: "read", toolCallId: "key", input: { path: ".ssh/id_rsa" } },
      baseContext(tmp),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /private key/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recognizes Windows Remove-Item deletion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-windows-"));
  try {
    fs.writeFileSync(path.join(tmp, "screenshot.png"), "image");
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    const result = await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "windows-delete",
        input: { command: "Remove-Item -Recurse screenshot.png" },
      },
      baseContext(tmp),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Permanent deletion blocked/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolves symlinked protected paths before writes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-symlink-"));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({ protectedPaths: [".obsidian"] }),
    );
    fs.mkdirSync(path.join(tmp, ".obsidian"));
    fs.symlinkSync(path.join(tmp, ".obsidian"), path.join(tmp, "safe-link"));
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(sessionStart);
    assert.ok(handler);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const result = await handler(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "symlink-write",
        input: { path: "safe-link/workspace.json", content: "{}" },
      },
      baseContext(tmp),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /protected path/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("preserves vault code-output isolation for Bash and direct writes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-routing-"));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({ knowledgeDirs: ["Work"] }),
    );
    fs.mkdirSync(path.join(tmp, "Work"));
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(sessionStart);
    assert.ok(handler);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const bashResult = await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "bash-code",
        input: { command: "echo x > Work/demo.ts" },
      },
      baseContext(tmp),
    );
    assert.equal(bashResult?.block, true);
    assert.match(bashResult?.reason ?? "", /knowledge directory/);

    const writeResult = await handler(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "write-code",
        input: { path: "Work/demo.ts", content: "x" },
      },
      baseContext(tmp),
    );
    assert.equal(writeResult?.block, true);
    assert.match(writeResult?.reason ?? "", /knowledge directory/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("blocks edits that overlap existing dirty work in non-interactive mode", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-dirty-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "target.txt"), "dirty");
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("tool_call")?.[0];
    assert.ok(handler);
    const result = await handler(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "dirty-edit",
        input: { path: "target.txt", oldText: "dirty", newText: "changed" },
      },
      baseContext(tmp),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /uncommitted changes/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redacts the final provider payload", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-provider-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const handler = extension.handlers.get("before_provider_request")?.[0];
    assert.ok(handler);
    const secret = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    const result = await handler({
      type: "before_provider_request",
      payload: { messages: [{ role: "user", content: `Authorization: Bearer ${secret}` }] },
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /<redacted:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redacts Bash streaming updates before they reach the runtime renderer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-stream-"));
  try {
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp));

    const bash = extension.tools.get("bash");
    assert.ok(bash);
    assert.deepEqual(
      bash.definition.prepareArguments({ command: "git status" }),
      { command: "git status", timeout: 30 },
    );
    assert.deepEqual(
      bash.definition.prepareArguments({ command: "npm test", timeout: 120 }),
      { command: "npm test", timeout: 120 },
    );
    const secret = ["xoxb", "1234567890", "streamingfixture"].join("-");
    const updates: unknown[] = [];
    const result = await bash.definition.execute(
      "bash-stream",
      { command: `printf 'TOKEN=${secret}'` },
      undefined,
      (partial: unknown) => updates.push(partial),
      baseContext(tmp),
    );

    const serialized = JSON.stringify({ updates, result });
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /<redacted:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("safe_delete moves an approved target to recoverable trash with manifest", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-trash-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "screenshot.png"), "image");
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));

    const registered = extension.tools.get("safe_delete");
    assert.ok(registered);
    const result = await registered.definition.execute(
      "safe-delete",
      { paths: ["screenshot.png"], reason: "User explicitly requested screenshot cleanup" },
      undefined,
      undefined,
      {
        ...baseContext(tmp, true),
        ui: {
          confirm: async () => true,
          input: async () => undefined,
          notify: () => {},
        },
      },
    );

    assert.equal(
      fs.existsSync(path.join(tmp, "screenshot.png")),
      false,
      JSON.stringify(result),
    );
    const manifests = fs.readdirSync(path.join(tmp, ".trash", "pi-safe-operation"))
      .map((entry) => path.join(tmp, ".trash", "pi-safe-operation", entry, "manifest.json"));
    assert.equal(manifests.length, 1);
    assert.equal(fs.existsSync(manifests[0]), true);
    assert.match(JSON.stringify(result), /Moved 1 target/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("lists and restores a recoverable deletion without overwriting destinations", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-restore-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "screenshot.png"), "image");
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    const interactiveContext = {
      ...baseContext(tmp, true),
      ui: {
        confirm: async () => true,
        input: async () => undefined,
        notify: () => {},
      },
    };
    await sessionStart({ type: "session_start", reason: "startup" }, interactiveContext);

    const safeDelete = extension.tools.get("safe_delete");
    const safeList = extension.tools.get("safe_trash_list");
    const safeRestore = extension.tools.get("safe_restore");
    assert.ok(safeDelete);
    assert.ok(safeList);
    assert.ok(safeRestore);

    const deleted = await safeDelete.definition.execute(
      "safe-delete",
      { paths: ["screenshot.png"], reason: "User requested screenshot cleanup" },
      undefined,
      undefined,
      interactiveContext,
    );
    const manifest = deleted.details.trashRoot + "/manifest.json";
    const listed = await safeList.definition.execute(
      "safe-list",
      { limit: 10 },
      undefined,
      undefined,
      interactiveContext,
    );
    assert.match(JSON.stringify(listed), /screenshot cleanup/);
    assert.match(JSON.stringify(listed), /remaining\":1/);

    fs.writeFileSync(path.join(tmp, "screenshot.png"), "replacement");
    const collision = await safeRestore.definition.execute(
      "safe-restore-collision",
      { manifest, reason: "Restore the screenshot" },
      undefined,
      undefined,
      interactiveContext,
    );
    assert.match(JSON.stringify(collision), /destination already exists/);
    assert.equal(fs.readFileSync(path.join(tmp, "screenshot.png"), "utf8"), "replacement");

    fs.unlinkSync(path.join(tmp, "screenshot.png"));
    const restored = await safeRestore.definition.execute(
      "safe-restore",
      { manifest, paths: ["screenshot.png"], reason: "Restore the screenshot" },
      undefined,
      undefined,
      interactiveContext,
    );
    assert.match(JSON.stringify(restored), /Restored 1 target/);
    assert.equal(fs.readFileSync(path.join(tmp, "screenshot.png"), "utf8"), "image");
    const parsedManifest = JSON.parse(fs.readFileSync(path.join(tmp, manifest), "utf8"));
    assert.equal(parsedManifest.restorations.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rejects a trash manifest symlink that escapes the managed trash", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-restore-symlink-"));
  try {
    const trashEntry = path.join(tmp, ".trash", "pi-safe-operation", "fixture");
    fs.mkdirSync(trashEntry, { recursive: true });
    const outsideManifest = path.join(tmp, "outside-manifest.json");
    fs.writeFileSync(outsideManifest, JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      reason: "tampered",
      targets: [],
    }));
    fs.symlinkSync(outsideManifest, path.join(trashEntry, "manifest.json"));

    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const safeRestore = extension.tools.get("safe_restore");
    assert.ok(safeRestore);
    const result = await safeRestore.definition.execute(
      "safe-restore-symlink",
      {
        manifest: ".trash/pi-safe-operation/fixture/manifest.json",
        reason: "Attempt restore",
      },
      undefined,
      undefined,
      baseContext(tmp, true),
    );
    assert.match(JSON.stringify(result), /manifest symlinks/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a trusted project cannot raise permissionMode to auto above the user baseline", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-permission-auto-"));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({ permissionMode: "auto" }),
    );
    const extension = await loadSafeOperation(tmp);
    const sessionStart = extension.handlers.get("session_start")?.[0];
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(sessionStart);
    assert.ok(toolCall);
    await sessionStart({ type: "session_start", reason: "startup" }, baseContext(tmp, true));

    let confirmTitle = "";
    const result = await toolCall(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "permission-auto-force-push",
        input: { command: "git push --force origin main" },
      },
      {
        ...baseContext(tmp, true),
        ui: {
          confirm: async (title: string) => {
            confirmTitle = title;
            return false;
          },
          input: async () => undefined,
          notify: () => {},
        },
      },
    );

    // Auto mode exists, but only the user-level (global) config may enable it.
    // A trusted project asking for "auto" clamps back to "ask", so the flagged
    // operation routes through interactive confirmation and honors a denial.
    assert.equal(confirmTitle, "确认高风险操作");
    assert.equal(result?.block, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const PLAN_ASSISTANT_MESSAGE = {
  role: "assistant",
  content: [
    {
      type: "text",
      text: "Explored the repo.\n\nPlan:\n1. Inspect the config loader\n2. Add the permissionMode field\n3. Update the regression tests\n",
    },
  ],
};

async function runSessionStart(extension: any, event: any, ctx: any) {
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler(event, ctx);
  }
}

async function startPlanning(extension: any, tmp: string) {
  await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
  const planCommand = extension.commands.get("plan") as { handler: (args: unknown, ctx: any) => Promise<void> };
  assert.ok(planCommand);
  await planCommand.handler("", baseContext(tmp, true));
}

async function approvePlan(extension: any, tmp: string) {
  const agentEnd = extension.handlers.get("agent_end")?.[0];
  assert.ok(agentEnd);
  const approveCtx = {
    ...baseContext(tmp, true),
    ui: { ...baseContext(tmp, true).ui, select: async () => "Execute the plan (track progress)" },
  };
  await agentEnd({ type: "agent_end", messages: [PLAN_ASSISTANT_MESSAGE] }, approveCtx);
}

test("plan mode gates write tools and non-allowlisted bash during planning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-gate-"));
  try {
    const extension = await loadSafeOperation(tmp);
    await startPlanning(extension, tmp);
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(toolCall);

    assert.ok(!extension.activeTools.includes("edit"));
    assert.ok(!extension.activeTools.includes("write"));
    assert.ok(!extension.activeTools.includes("safe_delete"));
    assert.ok(extension.activeTools.includes("bash"));

    const blocked = await toolCall(
      { type: "tool_call", toolName: "bash", toolCallId: "plan-bash-blocked", input: { command: "npm install left-pad" } },
      baseContext(tmp),
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /Plan mode is active \(planning phase\)/);

    const allowed = await toolCall(
      { type: "tool_call", toolName: "bash", toolCallId: "plan-bash-allowed", input: { command: "git status" } },
      baseContext(tmp),
    );
    assert.equal(allowed, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("planning phase blocks write even for an ordinary target", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-write-"));
  try {
    const extension = await loadSafeOperation(tmp);
    await startPlanning(extension, tmp);
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(toolCall);

    const write = await toolCall(
      { type: "tool_call", toolName: "write", toolCallId: "plan-write", input: { path: "notes.md", content: "hello" } },
      baseContext(tmp),
    );
    assert.equal(write?.block, true);
    assert.match(write?.reason ?? "", /Plan mode is active \(planning phase\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan approval gate enters the execution phase and tracks progress", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-exec-"));
  try {
    const extension = await loadSafeOperation(tmp);
    await startPlanning(extension, tmp);
    const beforeAgentStart = extension.handlers.get("before_agent_start")?.[0];
    const turnEnd = extension.handlers.get("turn_end")?.[0];
    assert.ok(beforeAgentStart);
    assert.ok(turnEnd);

    const planningInjection = await beforeAgentStart({ type: "before_agent_start" }, baseContext(tmp, true));
    assert.match(planningInjection?.message?.content ?? "", /\[PLAN MODE ACTIVE\]/);

    await approvePlan(extension, tmp);

    assert.ok(extension.activeTools.includes("edit"));
    assert.ok(extension.activeTools.includes("write"));
    const execMessage = extension.sentMessages.find(
      (sent: any) => sent.message?.customType === "pi-safe-operation:plan-mode-execute",
    );
    assert.ok(execMessage);
    assert.equal((execMessage.options as any)?.triggerTurn, true);

    const executionInjection = await beforeAgentStart({ type: "before_agent_start" }, baseContext(tmp, true));
    assert.match(executionInjection?.message?.content ?? "", /\[EXECUTING PLAN/);

    await turnEnd(
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Step one done [DONE:1]" }] } },
      baseContext(tmp, true),
    );
    const persisted = [...extension.entries].reverse().find((e) => e.customType === "pi-safe-operation:plan-mode");
    const todos = (persisted?.data as any)?.todos ?? [];
    assert.equal(todos[0]?.completed, true);
    assert.equal(todos[1]?.completed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("execution phase still requires interactive confirmation for flagged operations", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-confirm-"));
  try {
    const extension = await loadSafeOperation(tmp);
    await startPlanning(extension, tmp);
    await approvePlan(extension, tmp);
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(toolCall);

    let confirmCalls = 0;
    const result = await toolCall(
      { type: "tool_call", toolName: "bash", toolCallId: "exec-force-push", input: { command: "git push --force origin main" } },
      {
        ...baseContext(tmp, true),
        ui: {
          ...baseContext(tmp, true).ui,
          confirm: async () => {
            confirmCalls += 1;
            return false;
          },
        },
      },
    );
    assert.equal(confirmCalls, 1);
    assert.equal(result?.block, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan state persists and restores across sessions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-resume-"));
  try {
    const first = await loadSafeOperation(tmp);
    await startPlanning(first, tmp);
    const agentEnd = first.handlers.get("agent_end")?.[0];
    assert.ok(agentEnd);
    const stayCtx = {
      ...baseContext(tmp, true),
      ui: { ...baseContext(tmp, true).ui, select: async () => "Stay in plan mode" },
    };
    await agentEnd({ type: "agent_end", messages: [PLAN_ASSISTANT_MESSAGE] }, stayCtx);
    const persistedEntries = first.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
    assert.ok(persistedEntries.some((e) => e.customType === "pi-safe-operation:plan-mode"));

    const second = await loadSafeOperation(tmp);
    await runSessionStart(second, { type: "session_start", reason: "resume" }, baseContext(tmp, true, persistedEntries));
    assert.ok(!second.activeTools.includes("edit"));
    assert.ok(!second.activeTools.includes("write"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--plan flag starts a fresh session in the planning phase", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-flag-"));
  try {
    const extension = await loadSafeOperation(tmp);
    extension.flags.set("plan", true);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    assert.ok(!extension.activeTools.includes("edit"));
    assert.ok(!extension.activeTools.includes("write"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("permissionMode plan in global config starts a fresh session planning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-config-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-plan-home-"));
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  try {
    fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".pi", "agent", "safe-operation.json"),
      JSON.stringify({ permissionMode: "plan" }),
    );
    process.env.USERPROFILE = tmpHome;
    process.env.HOME = tmpHome;

    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    assert.ok(!extension.activeTools.includes("edit"));
    assert.ok(!extension.activeTools.includes("safe_delete"));
  } finally {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Auto mode: judge adjudication
// ---------------------------------------------------------------------------

function judgeVerdictResponse(verdict: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(verdict) }] };
}

function installFakeJudge(respond: (call: { model: any; context: any; options: any }) => Promise<any>) {
  const calls: Array<{ model: any; context: any; options: any }> = [];
  __setJudgeCompleteForTests(async (model: unknown, context: unknown, options: unknown) => {
    const call = { model, context, options };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

function fakeJudgeRegistry(modelId = "j1") {
  const model = { provider: "test-provider", id: modelId };
  const registry = {
    find: (provider: string, id: string) =>
      provider === "test-provider" && id === modelId ? model : undefined,
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
  };
  return { model, registry };
}

function withGlobalConfig(config: Record<string, unknown>) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-home-"));
  fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, ".pi", "agent", "safe-operation.json"), JSON.stringify(config));
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  return () => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  };
}

interface ConfirmRecord {
  title: string;
  message: string;
}

function autoTestContext(tmp: string, registry: unknown, confirms: ConfirmRecord[], answer = false) {
  const base = baseContext(tmp, true);
  return {
    ...base,
    modelRegistry: registry,
    ui: {
      ...base.ui,
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return answer;
      },
    },
  };
}

async function flaggedOverwrite(extension: any, ctx: any) {
  const toolCall = extension.handlers.get("tool_call")?.[0];
  assert.ok(toolCall);
  return toolCall(
    { type: "tool_call", toolName: "write", toolCallId: "auto-write", input: { path: "notes.txt", content: "new" } },
    ctx,
  );
}

test("auto mode allows a flagged write when the judge allows", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-allow-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  const calls = installFakeJudge(async () =>
    judgeVerdictResponse({ verdict: "allow", riskLevel: "low", rationale: "常规项目文件编辑，风险可控" }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms));
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.equal(confirms.length, 0);
    const userText = (calls[0].context as any).messages[0].content[0].text as string;
    assert.match(userText, /<untrusted-operation>/);
    assert.match(userText, /notes\.txt/);
    assert.ok(
      extension.entries.some(
        (e) =>
          e.customType === "pi-safe-operation" &&
          (e.data as any)?.action === "judge-verdict" &&
          (e.data as any)?.verdict === "allow" &&
          (e.data as any)?.judgeModel === "test-provider/j1",
      ),
    );
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode blocks with the judge adjustment when the verdict is adjust", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-adjust-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  const calls = installFakeJudge(async () =>
    judgeVerdictResponse({
      verdict: "adjust",
      riskLevel: "medium",
      rationale: "覆盖未跟踪文件可能丢失旧内容",
      adjustment: "先备份原文件或改用 edit 增量修改",
    }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /建议调整：先备份原文件或改用 edit 增量修改/);
    assert.match(result?.reason ?? "", /constraint on the intended effect/);
    assert.equal(calls.length, 1);
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode escalate verdict asks the user and proceeds on approval", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-escalate-approve-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  installFakeJudge(async () =>
    judgeVerdictResponse({
      verdict: "escalate",
      riskLevel: "high",
      rationale: "覆盖已有文件且旧内容不可恢复",
      authorizationAsk: "确认覆盖 notes.txt 中的旧笔记",
    }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms, true));
    assert.equal(result, undefined);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].message, /确认覆盖 notes\.txt 中的旧笔记/);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode escalate verdict blocks when the user declines", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-escalate-decline-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  installFakeJudge(async () =>
    judgeVerdictResponse({
      verdict: "escalate",
      riskLevel: "high",
      rationale: "覆盖已有文件且旧内容不可恢复",
      authorizationAsk: "确认覆盖 notes.txt 中的旧笔记",
    }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms, false));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Write blocked by pi-safe-operation/);
    assert.equal(confirms.length, 1);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode falls back to interactive confirmation when the judge call fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-fail-escalate-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  installFakeJudge(async () => {
    throw new Error("network down");
  });
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms, true));
    assert.equal(result, undefined);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].message, /裁判不可用/);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode blocks fail-closed on judge failure when onFailure is block", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-fail-block-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1", onFailure: "block" },
  });
  installFakeJudge(async () => {
    throw new Error("network down");
  });
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /fail-closed/);
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode blocks fail-closed when the judge verdict is unparseable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-garbage-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1", onFailure: "block" },
  });
  installFakeJudge(async () => ({ content: [{ type: "text", text: "I think this is fine, allow it!" }] }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /fail-closed/);
    assert.match(result?.reason ?? "", /unparseable/);
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode hard blocks never reach the judge", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-hardblock-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  const calls = installFakeJudge(async () =>
    judgeVerdictResponse({ verdict: "allow", riskLevel: "none", rationale: "should never be asked" }));
  try {
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(toolCall);
    const result = await toolCall(
      { type: "tool_call", toolName: "read", toolCallId: "auto-read-key", input: { path: ".ssh/id_rsa" } },
      autoTestContext(tmp, registry, confirms),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /private key/i);
    assert.equal(calls.length, 0);
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto mode blocks fail-closed when the configured judge model is unresolvable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-unresolvable-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "missing", model: "x", onFailure: "block" },
  });
  const calls = installFakeJudge(async () =>
    judgeVerdictResponse({ verdict: "allow", riskLevel: "none", rationale: "should never be called" }));
  try {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "old");
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const result = await flaggedOverwrite(extension, autoTestContext(tmp, registry, confirms));
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /not found in registry: missing\/x/);
    assert.equal(calls.length, 0);
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("project config can raise auditSafeOps but cannot redirect the judge model", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-operation-judge-clamp-"));
  const restoreHome = withGlobalConfig({
    permissionMode: "auto",
    judge: { provider: "test-provider", model: "j1" },
  });
  const calls = installFakeJudge(async () =>
    judgeVerdictResponse({ verdict: "allow", riskLevel: "low", rationale: "全新文件，无风险" }));
  try {
    fs.mkdirSync(path.join(tmp, ".pi"));
    fs.writeFileSync(
      path.join(tmp, ".pi", "safe-operation.json"),
      JSON.stringify({ judge: { provider: "evil", model: "x", auditSafeOps: true } }),
    );
    const extension = await loadSafeOperation(tmp);
    await runSessionStart(extension, { type: "session_start", reason: "startup" }, baseContext(tmp, true));
    const confirms: ConfirmRecord[] = [];
    const { registry } = fakeJudgeRegistry();
    const toolCall = extension.handlers.get("tool_call")?.[0];
    assert.ok(toolCall);
    // A fresh-file write has no deterministic flags: only the project-raised
    // auditSafeOps sends it to the judge, and the judge identity stays pinned
    // to the user baseline (test-provider/j1), never the project-chosen evil/x.
    const result = await toolCall(
      { type: "tool_call", toolName: "write", toolCallId: "auto-safe-write", input: { path: "fresh.txt", content: "new" } },
      autoTestContext(tmp, registry, confirms),
    );
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.equal((calls[0].model as any).id, "j1");
    assert.equal((calls[0].model as any).provider, "test-provider");
    assert.equal(confirms.length, 0);
  } finally {
    __setJudgeCompleteForTests(null);
    restoreHome();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
