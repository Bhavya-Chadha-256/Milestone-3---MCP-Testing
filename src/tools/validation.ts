import { invalidArgument, policyBlocked } from "../errors.js";
import { assertNoLineBreaks, type EmailAttachment } from "../services/mime.js";

/**
 * Semantic input validation for tools. Zod schemas only describe types; the
 * value rules live here so violations come back as structured INVALID_ARGUMENT
 * results rather than protocol-level schema errors.
 */

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** RFC 5322 addr-spec in its simple (dot-atom) form: local@domain.tld. */
export function isValidEmail(address: string): boolean {
  if (address.length > 254) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((l) => DOMAIN_LABEL.test(l)) && !/^\d+$/.test(labels.at(-1) ?? "");
}

export function validateAddressList(field: string, values: string[] | undefined, { min, max }: { min: number; max: number }) {
  const list = (values ?? []).map((v) => v.trim());
  if (list.length < min) throw invalidArgument(`${field} must contain at least ${min} address${min === 1 ? "" : "es"}.`);
  if (list.length > max) throw invalidArgument(`${field} may contain at most ${max} addresses (got ${list.length}).`);
  list.forEach((address, i) => validateAddress(`${field}[${i}]`, address));
  return list;
}

export function validateAddress(field: string, address: string): string {
  assertNoLineBreaks(field, address);
  if (!isValidEmail(address)) {
    throw invalidArgument(
      `${field} "${truncate(address, 80)}" is not a valid email address. Use a bare address such as name@example.com (display names are not supported).`,
    );
  }
  return address;
}

export function validateSubject(subject: string): string {
  assertNoLineBreaks("subject", subject);
  const length = [...subject].length;
  if (length < 1 || subject.trim() === "") throw invalidArgument("subject must not be empty.");
  if (length > 998) throw invalidArgument(`subject is ${length} characters; the maximum is 998.`);
  return subject;
}

export function validateMaxBytes(field: string, value: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw invalidArgument(`${field} is ${formatBytes(bytes)}; the maximum is ${formatBytes(maxBytes)}.`);
  }
}

/** Strip directories and control characters; header-breaking CR/LF is rejected, not stripped. */
export function sanitizeFilename(filename: string): string {
  assertNoLineBreaks("attachments.filename", filename);
  const base = filename.split(/[/\\]/).filter(Boolean).at(-1) ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 255) || "attachment";
}

const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded length of a base64 string, computed without decoding it. */
export function decodedBase64Length(normalized: string): number {
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

export interface RawAttachment {
  filename: string;
  mime_type: string;
  content_base64: string;
}

/**
 * Validates every attachment and enforces the total size limit *before*
 * decoding any payload (§12.3).
 */
export function decodeAttachments(raw: RawAttachment[] | undefined, maxTotalBytes: number): EmailAttachment[] {
  const items = (raw ?? []).map((a, i) => {
    const mimeType = a.mime_type.trim().toLowerCase();
    assertNoLineBreaks(`attachments[${i}].mime_type`, mimeType);
    if (!MIME_TYPE.test(mimeType)) {
      throw invalidArgument(`attachments[${i}].mime_type "${truncate(mimeType, 60)}" is not a valid MIME type such as application/pdf.`);
    }
    const normalized = a.content_base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!BASE64.test(normalized) || normalized.length % 4 === 1) {
      throw invalidArgument(`attachments[${i}].content_base64 is not valid base64.`);
    }
    return { filename: sanitizeFilename(a.filename), mimeType, normalized, size: decodedBase64Length(normalized) };
  });
  const total = items.reduce((n, a) => n + a.size, 0);
  if (total > maxTotalBytes) {
    throw policyBlocked(
      `Attachments total ${formatBytes(total)}, above this server's limit of ${formatBytes(maxTotalBytes)} (MAX_ATTACHMENT_BYTES). Nothing was sent.`,
    );
  }
  return items.map((a) => ({ filename: a.filename, mimeType: a.mimeType, content: Buffer.from(a.normalized, "base64") }));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
