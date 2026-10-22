import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors.js";
import { composeEmail, encodeHeaderWords, htmlToText, type OutgoingEmail } from "../../src/services/mime.js";

const base: OutgoingEmail = {
  from: "me@example.com",
  to: ["a@example.com"],
  cc: [],
  bcc: [],
  subject: "Weekly report",
  body: "Hello,\nAll good.",
  bodyFormat: "text",
  attachments: [],
};

const fixedDate = new Date("2026-10-22T14:03:00Z");
let n = 0;
const boundary = () => `BOUNDARY_${++n}`;

function compose(overrides: Partial<OutgoingEmail> = {}) {
  n = 0;
  const msg = composeEmail({ ...base, ...overrides }, { date: fixedDate, boundary });
  return { ...msg, text: msg.raw.toString("utf8") };
}

/** Split the raw message into its header block and body. */
function split(raw: string) {
  const i = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, i), body: raw.slice(i + 4) };
}

function decodeB64Parts(raw: string): string[] {
  return [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?:--|$)/g)].map((m) =>
    Buffer.from((m[1] ?? "").replace(/\r\n/g, ""), "base64").toString("utf8"),
  );
}

describe("composeEmail", () => {
  it("builds a plain-text message with CRLF line endings", () => {
    const { text, structure } = compose();
    const { headers } = split(text);
    expect(structure).toBe("text/plain");
    expect(headers).toContain("From: me@example.com");
    expect(headers).toContain("To: a@example.com");
    expect(headers).toContain("Subject: Weekly report");
    expect(headers).toContain("Date: Thu, 22 Oct 2026 14:03:00 +0000");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(text.replace(/\r\n/g, "")).not.toMatch(/\n/); // only CRLF
    expect(decodeB64Parts(text)).toEqual(["Hello,\nAll good."]);
  });

  it("builds multipart/alternative with a generated text part for HTML", () => {
    const { text, structure } = compose({
      bodyFormat: "html",
      body: "<h1>Report</h1><p>All <b>good</b> &amp; on track.</p><ul><li>One</li><li>Two</li></ul>",
    });
    expect(structure).toBe("multipart/alternative[text/plain,text/html]");
    expect(text).toContain('Content-Type: multipart/alternative; boundary="BOUNDARY_1"');
    const [plain, html] = decodeB64Parts(text);
    expect(plain).toBe("Report\n\nAll good & on track.\n\n- One\n- Two");
    expect(html).toContain("<h1>Report</h1>");
    expect(text.trimEnd().endsWith("--BOUNDARY_1--")).toBe(true);
  });

  it("wraps in multipart/mixed when there are attachments", () => {
    const pdf = Buffer.from("%PDF-1.4 fake");
    const { text, structure, attachmentBytes } = compose({
      bodyFormat: "html",
      body: "<p>See attached</p>",
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content: pdf }],
    });
    expect(structure).toBe("multipart/mixed[multipart/alternative[text/plain,text/html],application/pdf]");
    expect(text).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY_2"');
    expect(text).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(text).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(text).toContain(pdf.toString("base64"));
    expect(attachmentBytes).toBe(pdf.length);
  });

  it("encodes non-ASCII subjects per RFC 2047 and keeps bodies UTF-8", () => {
    const subject = "Résumé — 週報 ✅";
    const { text } = compose({ subject, body: "Grüße 👋" });
    const subjectLine = /Subject: (.*(?:\r\n .*)*)/.exec(text)?.[1] ?? "";
    expect(subjectLine).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subjectLine
      .split(/\r\n /)
      .flatMap((l) => l.split(" "))
      .map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)?.[1] ?? "", "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(subject);
    expect(decodeB64Parts(text)).toEqual(["Grüße 👋"]);
  });

  it("splits long encoded subjects into words of at most 75 chars without breaking characters", () => {
    const words = encodeHeaderWords("é".repeat(100));
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("é".repeat(100));
  });

  it("uses RFC 2231 for non-ASCII attachment filenames", () => {
    const { text } = compose({
      attachments: [{ filename: "résumé.txt", mimeType: "text/plain", content: Buffer.from("x") }],
    });
    expect(text).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
  });

  it("includes Bcc for Gmail to deliver, but never in the returned headers", () => {
    const { text, headers } = compose({ bcc: ["secret@example.com"], cc: ["c@example.com"], replyTo: "r@example.com" });
    expect(text).toContain("Bcc: secret@example.com");
    expect(text).toContain("Cc: c@example.com");
    expect(text).toContain("Reply-To: r@example.com");
    expect(JSON.stringify(headers)).not.toContain("secret@example.com");
    expect(headers.map((h) => h.name)).not.toContain("Bcc");
  });

  it("folds long recipient lists to lines of at most 78 chars", () => {
    const to = Array.from({ length: 10 }, (_, i) => `recipient-number-${i}@example.com`);
    const { text } = compose({ to });
    const toHeader = /To: .*(?:\r\n .*)*/.exec(text)?.[0] ?? "";
    for (const line of toHeader.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(toHeader.replace(/\r\n /g, " ")).toBe(`To: ${to.join(", ")}`);
  });

  it.each([
    ["subject", { subject: "Hi\r\nBcc: x@evil.com" }],
    ["subject (LF only)", { subject: "Hi\nBcc: x@evil.com" }],
    ["to", { to: ["a@example.com\r\nBcc: x@evil.com"] }],
    ["cc", { cc: ["a@example.com\nX: y"] }],
    ["bcc", { bcc: ["a@example.com\r"] }],
    ["reply_to", { replyTo: "a@example.com\r\nX: y" }],
    ["attachment filename", { attachments: [{ filename: "a\r\n.txt", mimeType: "text/plain", content: Buffer.from("") }] }],
  ])("rejects CR/LF in %s", (_label, overrides) => {
    try {
      compose(overrides as Partial<OutgoingEmail>);
      expect.fail("expected an error");
    } catch (err) {
      expect((err as ToolError).code).toBe("INVALID_ARGUMENT");
    }
  });
});

describe("htmlToText", () => {
  it("handles links, line breaks, entities and scripts", () => {
    expect(htmlToText('<p>Hi<br>there</p><a href="https://x.test">site</a><script>alert(1)</script>&#x1F44B;&nbsp;&lt;3')).toBe(
      "Hi\nthere\nsite (https://x.test)👋 <3",
    );
  });
});
