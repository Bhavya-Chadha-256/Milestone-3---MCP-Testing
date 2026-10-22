import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "../../src/errors.js";
import { connectClient, makeDeps } from "../helpers/fakes.js";

type Args = Record<string, unknown>;

async function call(args: Args, deps = makeDeps()) {
  const { client, close } = await connectClient(deps);
  try {
    const result = (await client.callTool({ name: "gmail_send_email", arguments: args })) as CallToolResult;
    return { result, deps, text: (result.content[0] as { text: string }).text, structured: result.structuredContent as any };
  } finally {
    await close();
  }
}

const basic = { to: ["a@example.com"], subject: "Weekly report", body: "All good." };

describe("gmail_send_email", () => {
  it("sends a plain-text email and returns text plus structuredContent", async () => {
    const { result, deps, text, structured } = await call(basic);
    expect(result.isError).toBeFalsy();
    expect(text).toBe('Email "Weekly report" sent to a@example.com (message id 18f3c0ffee).');
    expect(structured).toEqual({
      status: "sent",
      message_id: "18f3c0ffee",
      thread_id: "18f3c0ffee",
      from: "me@example.com",
      to: ["a@example.com"],
      cc: [],
      bcc_count: 0,
      subject: "Weekly report",
      attachment_count: 0,
    });
    expect(deps.email.sent).toHaveLength(1);
    expect(deps.email.sent[0]?.toString()).toContain("From: me@example.com");
  });

  it("sends HTML with one attachment", async () => {
    const { deps, structured } = await call({
      ...basic,
      body: "<p>See <b>attached</b></p>",
      body_format: "html",
      attachments: [{ filename: "report.csv", mime_type: "text/csv", content_base64: Buffer.from("a,b\n1,2").toString("base64") }],
    });
    expect(structured.attachment_count).toBe(1);
    const raw = deps.email.sent[0]?.toString() ?? "";
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain('filename="report.csv"');
  });

  it("never echoes BCC addresses, only their count", async () => {
    const { text, structured } = await call({ ...basic, bcc: ["hidden@example.com", "h2@example.com"] });
    expect(structured.bcc_count).toBe(2);
    expect(JSON.stringify(structured)).not.toContain("hidden@");
    expect(text).not.toContain("hidden@");
    expect(text).toContain("2 bcc");
  });

  it("dry_run builds a preview and sends nothing", async () => {
    const { deps, structured, text } = await call({ ...basic, dry_run: true, bcc: ["b@example.com"] });
    expect(deps.email.sent).toHaveLength(0);
    expect(structured.status).toBe("dry_run");
    expect(structured.message_id).toBeUndefined();
    expect(structured.preview.mime_structure).toBe("text/plain");
    expect(structured.preview.headers).toContainEqual({ name: "Subject", value: "Weekly report" });
    expect(JSON.stringify(structured.preview)).not.toContain("b@example.com");
    expect(text).toMatch(/^Dry run: .*NOT sent/);
  });

  it("rejects a subject with \\r\\nBcc: header injection as INVALID_ARGUMENT, sending nothing (§16.6)", async () => {
    const { result, deps, structured, text } = await call({ ...basic, subject: "Hello\r\nBcc: x@evil.com" });
    expect(result.isError).toBe(true);
    expect(structured.error).toMatchObject({ code: "INVALID_ARGUMENT", retryable: false });
    expect(text).toMatch(/^Error INVALID_ARGUMENT: subject must not contain line breaks/);
    expect(deps.email.sent).toHaveLength(0);
  });

  it("rejects recipients outside ALLOWED_RECIPIENT_DOMAINS with POLICY_BLOCKED, sending nothing (§16.5)", async () => {
    const deps = makeDeps({ env: { ALLOWED_RECIPIENT_DOMAINS: "mycompany.com" } });
    const { result, structured } = await call({ ...basic, to: ["a@mycompany.com"], cc: ["b@other.org"] }, deps);
    expect(result.isError).toBe(true);
    expect(structured.error.code).toBe("POLICY_BLOCKED");
    expect(structured.error.message).toContain("other.org");
    expect(deps.email.sent).toHaveLength(0);
  });

  it("applies the allowlist to dry runs too", async () => {
    const deps = makeDeps({ env: { ALLOWED_RECIPIENT_DOMAINS: "mycompany.com" } });
    const { structured } = await call({ ...basic, dry_run: true }, deps);
    expect(structured.error.code).toBe("POLICY_BLOCKED");
  });

  it.each([
    [{ to: [] }, "to must contain at least 1"],
    [{ to: ["not-an-email"] }, "not a valid email"],
    [{ reply_to: "nope" }, "reply_to"],
    [{ subject: "" }, "subject must not be empty"],
    [{ body: "x".repeat(500 * 1024 + 1) }, "body is"],
    [{ attachments: [{ filename: "a", mime_type: "text/plain", content_base64: "%%%" }] }, "not valid base64"],
  ])("returns INVALID_ARGUMENT for %o", async (overrides, message) => {
    const { structured } = await call({ ...basic, ...overrides });
    expect(structured.error.code).toBe("INVALID_ARGUMENT");
    expect(structured.error.message).toContain(message);
  });

  it("enforces the attachment size limit", async () => {
    const deps = makeDeps({ env: { MAX_ATTACHMENT_BYTES: "10" } });
    const { structured } = await call(
      { ...basic, attachments: [{ filename: "a", mime_type: "text/plain", content_base64: Buffer.alloc(11).toString("base64") }] },
      deps,
    );
    expect(structured.error.code).toBe("POLICY_BLOCKED");
  });

  it("rate-limits real sends but not dry runs", async () => {
    const deps = makeDeps({ env: { RATE_LIMIT_EMAILS_PER_HOUR: "1" } });
    expect((await call(basic, deps)).structured.status).toBe("sent");
    expect((await call({ ...basic, dry_run: true }, deps)).structured.status).toBe("dry_run");
    const limited = await call(basic, deps);
    expect(limited.structured.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(limited.structured.error.retry_after_seconds).toBeGreaterThan(0);
  });

  it("REQUIRE_DRY_RUN_FIRST: rejects a send until an identical dry run happened", async () => {
    const deps = makeDeps({ env: { REQUIRE_DRY_RUN_FIRST: "true" } });
    expect((await call(basic, deps)).structured.error.code).toBe("POLICY_BLOCKED");
    await call({ ...basic, dry_run: true }, deps);
    expect((await call({ ...basic, body: "changed" }, deps)).structured.error.code).toBe("POLICY_BLOCKED");
    expect((await call(basic, deps)).structured.status).toBe("sent");
  });

  it("surfaces service errors such as AUTH_REQUIRED as structured results", async () => {
    const deps = makeDeps();
    deps.email.error = new ToolError("AUTH_REQUIRED", "Not authorized with Google. Run `npx -y gmail-gdocs-mcp auth`.");
    const { result, structured } = await call(basic, deps);
    expect(result.isError).toBe(true);
    expect(structured.error).toEqual({
      code: "AUTH_REQUIRED",
      message: "Not authorized with Google. Run `npx -y gmail-gdocs-mcp auth`.",
      retryable: false,
    });
  });
});
