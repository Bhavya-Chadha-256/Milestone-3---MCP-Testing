import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../../src/transports/http.js";
import { makeDeps } from "../helpers/fakes.js";

// craftsman-ignore: SEC001 -- dummy bearer token for a local test server
const TOKEN = "test-token-0123456789abcdef";
const servers: Server[] = [];

async function listen(env: Record<string, string>) {
  const app = createHttpApp(makeDeps({ env: { MCP_TRANSPORT: "http", ...env } }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

function post(url: string, headers: Record<string, string> = {}, body = initialize) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

/** fetch() refuses to set Host, so spoofed-Host requests go through node:http. */
function postWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(initialize);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("HTTP transport (§9.4, §16.8)", () => {
  it("refuses to start without MCP_AUTH_TOKEN", () => {
    expect(() => createHttpApp(makeDeps({ env: { MCP_TRANSPORT: "http" } }))).toThrow(/requires MCP_AUTH_TOKEN/);
  });

  it("returns 401 without the correct bearer token", async () => {
    const url = await listen({ MCP_AUTH_TOKEN: TOKEN });
    const missing = await post(url);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect((await post(url, { Authorization: "Bearer wrong-token-xxxxxxxxxxxx" })).status).toBe(401);
    expect((await post(url, { Authorization: TOKEN })).status).toBe(401);
  });

  it("serves MCP to an authenticated client", async () => {
    const url = await listen({ MCP_AUTH_TOKEN: TOKEN });
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gdocs_append_text", "gmail_send_email", "google_auth_status"]);
    const result = await client.callTool({
      name: "gmail_send_email",
      arguments: { to: ["a@example.com"], subject: "Hi", body: "x", dry_run: true },
    });
    expect(result.structuredContent).toMatchObject({ status: "dry_run" });
    await client.close();
  });

  it("rejects disallowed Origins (DNS rebinding) and never uses a CORS wildcard", async () => {
    const url = await listen({ MCP_AUTH_TOKEN: TOKEN, MCP_ALLOWED_ORIGINS: "https://app.example.com" });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await post(url, { ...auth, Origin: "https://evil.example" })).status).toBe(403);
    const allowed = await post(url, { ...auth, Origin: "https://app.example.com" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    const local = await post(url, { ...auth, Origin: "http://localhost:6274" });
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("unauthenticated loopback mode only accepts loopback Host headers", async () => {
    const url = await listen({ MCP_ALLOW_UNAUTHENTICATED: "true" });
    expect((await post(url)).status).toBe(200);
    expect(await postWithHost(url, "attacker.example")).toBe(403);
    expect(await postWithHost(url, "localhost:3000")).toBe(200);
  });

  it("answers bad JSON and unsupported methods with JSON-RPC errors", async () => {
    const url = await listen({ MCP_AUTH_TOKEN: TOKEN });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const bad = await post(url, auth, "{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    const get = await fetch(url, { headers: auth });
    expect(get.status).toBe(405);
  });

  it("has an unauthenticated health check that reveals nothing", async () => {
    const url = await listen({ MCP_AUTH_TOKEN: TOKEN });
    const res = await fetch(url.replace("/mcp", "/healthz"));
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
