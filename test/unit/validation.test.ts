import { describe, expect, it } from "vitest";
import {
  decodeAttachments,
  decodedBase64Length,
  isValidEmail,
  sanitizeFilename,
  validateAddressList,
  validateSubject,
} from "../../src/tools/validation.js";

describe("isValidEmail", () => {
  it.each(["a@example.com", "first.last+tag@sub.example.co.uk", "o'neil@example.org", "x_y-z@ex-ample.io"])("accepts %s", (a) =>
    expect(isValidEmail(a)).toBe(true),
  );
  it.each([
    "plainaddress",
    "@example.com",
    "a@",
    "a@localhost",
    "a@example..com",
    "a..b@example.com",
    ".a@example.com",
    "a b@example.com",
    "Jane <jane@example.com>",
    "a@-example.com",
    "a@example.123",
    `${"x".repeat(65)}@example.com`,
  ])("rejects %s", (a) => expect(isValidEmail(a)).toBe(false));
});

describe("field validation", () => {
  it("rejects the header-injection subject from the acceptance criteria", () => {
    expect(() => validateSubject("Hello\r\nBcc: x@evil.com")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("enforces subject length 1-998 in characters", () => {
    expect(() => validateSubject("")).toThrow();
    expect(() => validateSubject("   ")).toThrow();
    expect(validateSubject("é".repeat(998))).toHaveLength(998);
    expect(() => validateSubject("a".repeat(999))).toThrow(/998/);
  });

  it("enforces list sizes and trims addresses", () => {
    expect(validateAddressList("to", [" a@example.com "], { min: 1, max: 50 })).toEqual(["a@example.com"]);
    expect(() => validateAddressList("to", [], { min: 1, max: 50 })).toThrow(/at least 1/);
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect(() => validateAddressList("cc", many, { min: 0, max: 50 })).toThrow(/at most 50/);
    expect(() => validateAddressList("to", ["a@example.com", "bad"], { min: 1, max: 50 })).toThrow(/to\[1\]/);
  });
});

describe("attachments", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("computes decoded size without decoding", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "hello world!"]) {
      expect(decodedBase64Length(b64(s))).toBe(Buffer.byteLength(s));
    }
  });

  it("sanitizes filenames by stripping path separators", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("..hidden")).toBe("hidden");
    expect(sanitizeFilename("a\u0000b.txt")).toBe("ab.txt");
    expect(sanitizeFilename("/")).toBe("attachment");
    expect(() => sanitizeFilename("a\r\nb")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("decodes valid attachments, accepting base64url and line-wrapped input", () => {
    const [a, b] = decodeAttachments(
      [
        { filename: "a.txt", mime_type: "Text/Plain", content_base64: `${b64("hello").slice(0, 4)}\n${b64("hello").slice(4)}` },
        { filename: "b.bin", mime_type: "application/octet-stream", content_base64: Buffer.from([251, 255]).toString("base64url") },
      ],
      1000,
    );
    expect(a).toEqual({ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello") });
    expect(b?.content).toEqual(Buffer.from([251, 255]));
  });

  it("rejects invalid base64 and MIME types", () => {
    expect(() => decodeAttachments([{ filename: "a", mime_type: "text/plain", content_base64: "not base64!" }], 100)).toThrow(
      /not valid base64/,
    );
    expect(() => decodeAttachments([{ filename: "a", mime_type: "pdf", content_base64: "" }], 100)).toThrow(/MIME type/);
  });

  it("enforces the total size limit before decoding", () => {
    const big = "A".repeat(4 * 1000); // 3000 bytes decoded
    expect(() =>
      decodeAttachments(
        [
          { filename: "1", mime_type: "text/plain", content_base64: big },
          { filename: "2", mime_type: "text/plain", content_base64: big },
        ],
        5000,
      ),
    ).toThrow(expect.objectContaining({ code: "POLICY_BLOCKED" }));
  });
});
