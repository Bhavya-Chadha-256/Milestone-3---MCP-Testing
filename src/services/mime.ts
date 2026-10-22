import { randomBytes } from "node:crypto";
import { invalidArgument } from "../errors.js";

/**
 * Minimal RFC 5322 / MIME composer for Gmail's `messages.send` (§8.1 step 3).
 * Every part body is base64-encoded, so boundaries (which contain "_" and ".")
 * can never collide with part content.
 */

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface OutgoingEmail {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  body: string;
  bodyFormat: "text" | "html";
  attachments: EmailAttachment[];
}

export interface ComposedMessage {
  /** Full RFC 5322 message, CRLF line endings. */
  raw: Buffer;
  /** Top-level headers, excluding Bcc (never echoed back). */
  headers: Array<{ name: string; value: string }>;
  /** e.g. "multipart/mixed[multipart/alternative[text/plain,text/html],application/pdf]" */
  structure: string;
  bodyBytes: number;
  attachmentBytes: number;
}

export interface ComposeOptions {
  date?: Date;
  boundary?: () => string;
}

const CRLF = "\r\n";

export function assertNoLineBreaks(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw invalidArgument(`${field} must not contain line breaks (CR or LF); this is blocked to prevent header injection.`);
  }
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" encoded-words, each ≤ 75 chars, never splitting a UTF-8 sequence. */
export function encodeHeaderWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words;
}

/** Fold a header at whitespace so lines stay ≤ 78 chars where possible (RFC 5322 §2.2.3). */
export function foldHeader(name: string, value: string): string {
  const tokens = value.split(" ");
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of tokens) {
    if (line.length + 1 + token.length > 78 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

export function encodeSubject(subject: string): string {
  return isPrintableAscii(subject) ? subject : encodeHeaderWords(subject).join(" ");
}

function formatDate(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

function wrapBase64(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);
}

function quoteParam(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** Content-Disposition filename: quoted ASCII, or RFC 2231 `filename*` for anything else. */
function filenameParams(filename: string): { disposition: string; typeName: string } {
  if (isPrintableAscii(filename)) {
    return { disposition: `filename=${quoteParam(filename)}`, typeName: `name=${quoteParam(filename)}` };
  }
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    disposition: `filename*=UTF-8''${encoded}`,
    typeName: `name=${quoteParam(encodeHeaderWords(filename).join(" "))}`,
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain-text alternative for an HTML body: readable, not perfect. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, text: string) =>
      text.trim() && text.trim() !== href ? `${text} (${href})` : href,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
      if (ent[0] === "#") {
        const code = ent[1]?.toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[ent.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Part {
  headers: string[];
  body: string;
  structure: string;
}

function textPart(mimeType: "text/plain" | "text/html", content: string): Part {
  return {
    headers: [`Content-Type: ${mimeType}; charset=UTF-8`, "Content-Transfer-Encoding: base64"],
    body: wrapBase64(Buffer.from(content, "utf8")),
    structure: mimeType,
  };
}

function multipart(subtype: "alternative" | "mixed", parts: Part[], boundary: string): Part {
  const body = [
    ...parts.map((p) => `--${boundary}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}`),
    `--${boundary}--`,
  ].join(CRLF);
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body,
    structure: `multipart/${subtype}[${parts.map((p) => p.structure).join(",")}]`,
  };
}

function attachmentPart(a: EmailAttachment): Part {
  const { disposition, typeName } = filenameParams(a.filename);
  return {
    headers: [
      `Content-Type: ${a.mimeType}; ${typeName}`,
      `Content-Disposition: attachment; ${disposition}`,
      "Content-Transfer-Encoding: base64",
    ],
    body: wrapBase64(a.content),
    structure: a.mimeType,
  };
}

const defaultBoundary = () => `=_gmail-gdocs-mcp_${randomBytes(12).toString("hex")}`;

export function composeEmail(email: OutgoingEmail, options: ComposeOptions = {}): ComposedMessage {
  const boundary = options.boundary ?? defaultBoundary;
  for (const [field, values] of [
    ["to", email.to],
    ["cc", email.cc],
    ["bcc", email.bcc],
  ] as const) {
    values.forEach((v) => assertNoLineBreaks(field, v));
  }
  if (email.from) assertNoLineBreaks("from", email.from);
  if (email.replyTo) assertNoLineBreaks("reply_to", email.replyTo);
  assertNoLineBreaks("subject", email.subject);
  for (const a of email.attachments) {
    assertNoLineBreaks("attachments.filename", a.filename);
    assertNoLineBreaks("attachments.mime_type", a.mimeType);
  }

  let content: Part =
    email.bodyFormat === "html"
      ? multipart("alternative", [textPart("text/plain", htmlToText(email.body)), textPart("text/html", email.body)], boundary())
      : textPart("text/plain", email.body);
  if (email.attachments.length > 0) {
    content = multipart("mixed", [content, ...email.attachments.map(attachmentPart)], boundary());
  }

  const visible: Array<{ name: string; value: string }> = [];
  if (email.from) visible.push({ name: "From", value: email.from });
  visible.push({ name: "To", value: email.to.join(", ") });
  if (email.cc.length > 0) visible.push({ name: "Cc", value: email.cc.join(", ") });
  if (email.replyTo) visible.push({ name: "Reply-To", value: email.replyTo });
  visible.push({ name: "Subject", value: email.subject });
  visible.push({ name: "Date", value: formatDate(options.date ?? new Date()) });

  const headerLines = visible.map(({ name, value }) => foldHeader(name, name === "Subject" ? encodeSubject(value) : value));
  // Gmail delivers to Bcc recipients and strips this header from delivered copies.
  if (email.bcc.length > 0) headerLines.push(foldHeader("Bcc", email.bcc.join(", ")));
  headerLines.push("MIME-Version: 1.0", ...content.headers);

  const raw = Buffer.from(`${headerLines.join(CRLF)}${CRLF}${CRLF}${content.body}${CRLF}`, "utf8");
  return {
    raw,
    headers: [...visible, ...content.headers.map(splitHeader)],
    structure: content.structure,
    bodyBytes: Buffer.byteLength(email.body, "utf8"),
    attachmentBytes: email.attachments.reduce((n, a) => n + a.content.length, 0),
  };
}

function splitHeader(line: string) {
  const i = line.indexOf(":");
  return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
}
