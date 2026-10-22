import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createDefaultDeps } from "../../src/server.js";
import { connectClient } from "../helpers/fakes.js";

/**
 * Opt-in: RUN_INTEGRATION=1 with real credentials (run `npm run auth` first) and
 *   TEST_EMAIL_TO=<address that receives the test emails>
 *   TEST_DOC_ID=<doc the account can edit>
 *   TEST_READONLY_DOC_ID=<optional: doc the account can only view>
 * These tests send real email and modify a real document.
 */
const enabled = process.env.RUN_INTEGRATION === "1";
if (enabled) dotenv.config({ quiet: true });
const to = process.env.TEST_EMAIL_TO ?? "";
const docId = process.env.TEST_DOC_ID ?? "";

describe.skipIf(!enabled)("Google integration", () => {
  let call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  let close: () => Promise<unknown>;

  beforeAll(async () => {
    expect(to, "set TEST_EMAIL_TO").not.toBe("");
    expect(docId, "set TEST_DOC_ID").not.toBe("");
    const config = loadConfig(process.env);
    const conn = await connectClient(createDefaultDeps(config, createLogger("warn")));
    close = conn.close;
    call = async (name, args) => (await conn.client.callTool({ name, arguments: args })) as CallToolResult;
  });
  afterAll(() => close?.());

  it("is authorized with exactly the required API scopes", async () => {
    const { structuredContent } = await call("google_auth_status", {});
    expect(structuredContent).toMatchObject({ authorized: true });
    const scopes = (structuredContent?.scopes as string[]).filter((s) => s.startsWith("https://www.googleapis.com/auth/") && !s.endsWith("userinfo.email"));
    expect(scopes.sort()).toEqual(["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/gmail.send"]);
  });

  it("dry-runs an email", async () => {
    const r = await call("gmail_send_email", { to: [to], subject: "gmail-gdocs-mcp dry run", body: "x", dry_run: true });
    expect(r.structuredContent).toMatchObject({ status: "dry_run" });
  });

  it("sends a plain-text email and an HTML email with an attachment", async () => {
    const stamp = new Date().toISOString();
    const plain = await call("gmail_send_email", { to: [to], subject: `gmail-gdocs-mcp plain ${stamp}`, body: "Plain text test ✅" });
    expect(plain.structuredContent).toMatchObject({ status: "sent" });
    const html = await call("gmail_send_email", {
      to: [to],
      subject: `gmail-gdocs-mcp HTML — ${stamp}`,
      body: "<h2>HTML test</h2><p>With an <b>attachment</b>.</p>",
      body_format: "html",
      attachments: [{ filename: "test.csv", mime_type: "text/csv", content_base64: Buffer.from("a,b\n1,2\n").toString("base64") }],
    });
    expect(html.structuredContent).toMatchObject({ status: "sent", attachment_count: 1 });
  });

  it("appends a heading followed by a bullet list", async () => {
    const heading = await call("gdocs_append_text", { document: docId, text: "Integration test", paragraph_style: "HEADING_2", timestamp_prefix: true });
    expect(heading.structuredContent).toMatchObject({ status: "appended" });
    const bullets = await call("gdocs_append_text", { document: docId, text: "first item\nsecond item", as_bullets: true });
    expect(bullets.structuredContent).toMatchObject({ status: "appended" });
  });

  it.skipIf(!process.env.TEST_READONLY_DOC_ID)("reports PERMISSION_DENIED for a view-only doc", async () => {
    const r = await call("gdocs_append_text", { document: process.env.TEST_READONLY_DOC_ID, text: "should fail" });
    expect(r.structuredContent).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
  });
});
