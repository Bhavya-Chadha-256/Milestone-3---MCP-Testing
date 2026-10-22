import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthProvider } from "../../src/auth/index.js";
import { createLogger } from "../../src/logger.js";
import { GoogleDocsService } from "../../src/services/gdocs.js";
import { GmailService } from "../../src/services/gmail.js";
import { startStdio } from "../../src/transports/stdio.js";
import { makeDeps } from "../helpers/fakes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(root, "dist", "index.js");

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  result?: {
    serverInfo?: { name: string };
    tools?: unknown[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: unknown;
}

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol-test", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "google_auth_status", arguments: {} } },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "gmail_send_email", arguments: { to: ["a@example.com"], subject: "Hi", body: "x", dry_run: true } },
  },
  {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "gdocs_append_text", arguments: { document: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", text: "x" } },
  },
];

/** Every non-empty stdout line must be a JSON-RPC 2.0 message. */
function parseProtocolLines(stdout: string): RpcMessage[] {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  return lines.map((line) => {
    const msg = JSON.parse(line) as RpcMessage;
    expect(msg.jsonrpc).toBe("2.0");
    return msg;
  });
}

function assertResponses(messages: RpcMessage[]) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  expect(byId.get(1)?.result?.serverInfo?.name).toBe("gmail-gdocs-mcp");
  expect(byId.get(2)?.result?.tools).toHaveLength(3);
  expect(byId.get(3)?.result?.structuredContent).toMatchObject({ authorized: false });
  expect(byId.get(4)?.result?.structuredContent).toMatchObject({ status: "dry_run" });
  expect(byId.get(5)?.result).toMatchObject({ isError: true, structuredContent: { error: { code: "AUTH_REQUIRED" } } });
}

const lineCount = (s: string) => s.split("\n").filter(Boolean).length;

describe("stdio protocol (§14, §16.9)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("in-process: answers initialize, tools/list and tools/call, writing nothing to the real stdout", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));

    // Real (non-fake) auth and services with no credentials, debug logging enabled.
    const base = makeDeps();
    const logger = createLogger("debug", () => {});
    const auth = createAuthProvider(base.config, logger);
    const deps = { ...base, logger, auth, email: new GmailService(auth, logger), docs: new GoogleDocsService(auth, logger) };
    const { close } = await startStdio(deps, { stdin, stdout });

    for (const r of requests) stdin.write(`${JSON.stringify(r)}\n`);
    await vi.waitFor(() => expect(lineCount(output)).toBe(5), { timeout: 5000 });
    await close();

    assertResponses(parseProtocolLines(output));
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(entry))("spawned binary: stdout contains only JSON-RPC messages", async () => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GOOGLE_TOKEN_PATH: "/nonexistent/gmail-gdocs-mcp/token.json",
        LOG_LEVEL: "debug",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    await vi.waitFor(() => expect(lineCount(stdout)).toBe(5), { timeout: 10000 });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    assertResponses(parseProtocolLines(stdout));
    expect(code).toBe(0);
    // Logs went to stderr, as JSON lines.
    expect(stderr).toContain('"msg":"server started"');
    expect(stderr).toContain('"tool":"gdocs_append_text"');
  });
});
