import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { emailDomain } from "../logger.js";
import { composeEmail, type OutgoingEmail } from "../services/gmail.js";
import { runTool, successResult, type ToolDeps } from "./common.js";
import {
  decodeAttachments,
  validateAddress,
  validateAddressList,
  validateMaxBytes,
  validateSubject,
  type RawAttachment,
} from "./validation.js";

export const GMAIL_SEND_EMAIL = "gmail_send_email";

const MAX_LIST = 50;
const MAX_BODY_BYTES = 500 * 1024;

export const gmailSendEmailInput = {
  to: z.array(z.string()).describe("Recipient email addresses (1-50), e.g. [\"alice@example.com\"]. Bare addresses only."),
  subject: z.string().describe("Subject line, 1-998 characters, single line (no line breaks)."),
  body: z.string().describe("Message body, up to 500 KB. Plain text, or HTML when body_format is \"html\"."),
  body_format: z
    .enum(["text", "html"])
    .default("text")
    .describe("\"text\" (default) or \"html\". For HTML a plain-text alternative is generated automatically."),
  cc: z.array(z.string()).optional().describe("CC addresses, at most 50."),
  bcc: z.array(z.string()).optional().describe("BCC addresses, at most 50. They are never echoed back, only counted."),
  reply_to: z.string().optional().describe("Address for the Reply-To header."),
  attachments: z
    .array(
      z.object({
        filename: z.string().describe("File name shown to the recipient, e.g. \"report.pdf\"."),
        mime_type: z.string().describe("MIME type, e.g. \"application/pdf\" or \"text/csv\"."),
        content_base64: z.string().describe("File content, base64-encoded."),
      }),
    )
    .optional()
    .describe("Small file attachments. Total decoded size is limited by the server (default 10 MB)."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("When true, validate and build the message and return a preview, but do NOT send it."),
};

const previewSchema = z.object({
  headers: z.array(z.object({ name: z.string(), value: z.string() })).describe("Message headers (Bcc omitted)."),
  mime_structure: z.string(),
  raw_size_bytes: z.number().int(),
  body_size_bytes: z.number().int(),
  attachment_size_bytes: z.number().int(),
});

export const gmailSendEmailOutput = {
  status: z.enum(["sent", "dry_run"]),
  message_id: z.string().optional().describe("Gmail message ID (sent only)."),
  thread_id: z.string().optional().describe("Gmail thread ID (sent only)."),
  from: z.string().optional().describe("Sending account, when known."),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc_count: z.number().int(),
  subject: z.string(),
  attachment_count: z.number().int(),
  preview: previewSchema.optional().describe("Computed headers and sizes (dry_run only)."),
};

type Input = z.infer<z.ZodObject<typeof gmailSendEmailInput>>;

/** Turn raw tool arguments into a validated message, or throw INVALID_ARGUMENT / POLICY_BLOCKED. */
export function normalizeEmailInput(args: Input, maxAttachmentBytes: number): OutgoingEmail {
  const to = validateAddressList("to", args.to, { min: 1, max: MAX_LIST });
  const cc = validateAddressList("cc", args.cc, { min: 0, max: MAX_LIST });
  const bcc = validateAddressList("bcc", args.bcc, { min: 0, max: MAX_LIST });
  const replyTo = args.reply_to?.trim() ? validateAddress("reply_to", args.reply_to.trim()) : undefined;
  const subject = validateSubject(args.subject);
  validateMaxBytes("body", args.body, MAX_BODY_BYTES);
  const attachments = decodeAttachments(args.attachments as RawAttachment[] | undefined, maxAttachmentBytes);
  return { to, cc, bcc, replyTo, subject, body: args.body, bodyFormat: args.body_format ?? "text", attachments };
}

/** Identity of a message's content, used by REQUIRE_DRY_RUN_FIRST to match a preview to a send. */
export function emailFingerprint(email: OutgoingEmail): string {
  const canonical = JSON.stringify({
    to: email.to.map((a) => a.toLowerCase()),
    cc: email.cc.map((a) => a.toLowerCase()),
    bcc: email.bcc.map((a) => a.toLowerCase()),
    replyTo: email.replyTo?.toLowerCase(),
    subject: email.subject,
    body: email.body,
    bodyFormat: email.bodyFormat,
    attachments: email.attachments.map((a) => [a.filename, a.mimeType, createHash("sha256").update(a.content).digest("hex")]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function handleGmailSendEmail(deps: ToolDeps, args: Input) {
  return runTool(GMAIL_SEND_EMAIL, deps.logger, async (log) => {
    const email = normalizeEmailInput(args, deps.config.policy.maxAttachmentBytes);
    const dryRun = args.dry_run ?? false;
    log.dry_run = dryRun;
    log.recipient_domains = [...new Set([...email.to, ...email.cc, ...email.bcc].map(emailDomain))];
    log.attachment_count = email.attachments.length;

    deps.policy.checkRecipients(email);
    const fingerprint = emailFingerprint(email);
    if (!dryRun) deps.policy.checkDryRunRequirement(fingerprint);

    const from = await deps.email.getFromAddress();
    const composed = composeEmail({ ...email, from }, { date: deps.now?.() });
    const summary = {
      ...(from ? { from } : {}),
      to: email.to,
      cc: email.cc,
      bcc_count: email.bcc.length,
      subject: email.subject,
      attachment_count: email.attachments.length,
    };

    if (dryRun) {
      deps.policy.recordDryRun(fingerprint);
      const structured = {
        status: "dry_run" as const,
        ...summary,
        preview: {
          headers: composed.headers,
          mime_structure: composed.structure,
          raw_size_bytes: composed.raw.length,
          body_size_bytes: composed.bodyBytes,
          attachment_size_bytes: composed.attachmentBytes,
        },
      };
      const text = `Dry run: email "${email.subject}" to ${recipientsText(email)} is valid and was NOT sent (${composed.structure}, ${composed.raw.length} bytes).`;
      return { result: successResult(text, structured) };
    }

    deps.policy.acquireEmailSend();
    const sent = await deps.email.sendRaw(composed.raw);
    deps.policy.consumeDryRun(fingerprint);
    const structured = { status: "sent" as const, message_id: sent.id, thread_id: sent.threadId, ...summary };
    const text = `Email "${email.subject}" sent to ${recipientsText(email)} (message id ${sent.id}).`;
    return { result: successResult(text, structured), googleRequestId: sent.requestId };
  });
}

function recipientsText(email: OutgoingEmail): string {
  const parts = [email.to.join(", ")];
  if (email.cc.length > 0) parts.push(`cc ${email.cc.join(", ")}`);
  if (email.bcc.length > 0) parts.push(`${email.bcc.length} bcc`);
  return parts.join("; ");
}

export function registerGmailSendEmail(server: McpServer, deps: ToolDeps) {
  server.registerTool(
    GMAIL_SEND_EMAIL,
    {
      title: "Send Gmail email",
      description:
        "Send an email from the user's Gmail account. Use only when the user has clearly asked to send an email. Supports plain text or HTML bodies, CC, BCC, and small attachments.",
      inputSchema: gmailSendEmailInput,
      outputSchema: gmailSendEmailOutput,
      annotations: {
        title: "Send Gmail email",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => handleGmailSendEmail(deps, args),
  );
}
