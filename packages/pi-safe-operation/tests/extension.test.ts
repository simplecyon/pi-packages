import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import safeOperation from "../src/index.ts";

async function loadSafeOperation(cwd: string) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, { definition: any }>();
  const commands = new Map<string, unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
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
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
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
  return { handlers, tools, commands, entries };
}

function baseContext(cwd: string, hasUI = false) {
  return {
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "print",
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
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
