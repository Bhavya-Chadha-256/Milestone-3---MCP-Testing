import { Readable } from "node:stream";
import { google } from "googleapis";
import type { AuthProvider } from "../auth/provider.js";
import { ToolError, googleRequestId, mapGoogleError, withRetry, type RetryOptions } from "../errors.js";
import type { Logger } from "../logger.js";

export { composeEmail, type ComposedMessage, type OutgoingEmail, type EmailAttachment } from "./mime.js";

export interface GmailSendResult {
  id: string;
  threadId: string;
  requestId?: string;
}

/** What the tool layer needs from Gmail; mocked in tests. */
export interface EmailSender {
  /** Authenticated account address, cached after the first lookup. */
  getFromAddress(): Promise<string | undefined>;
  sendRaw(raw: Buffer): Promise<GmailSendResult>;
}

/**
 * Gmail's JSON `raw` field is fine for ordinary messages; larger ones go
 * through the media-upload endpoint, which accepts up to 35 MB.
 */
const RAW_JSON_LIMIT_BYTES = 4 * 1024 * 1024;

export class GmailService implements EmailSender {
  private fromAddress?: string;

  constructor(
    private readonly auth: AuthProvider,
    private readonly logger: Logger,
    private readonly retry: RetryOptions = {},
  ) {}

  async getFromAddress(): Promise<string | undefined> {
    this.fromAddress ??= await this.auth.getUserEmail();
    return this.fromAddress;
  }

  async sendRaw(raw: Buffer): Promise<GmailSendResult> {
    const authClient = await this.auth.getClient("gmail");
    const gmail = google.gmail({ version: "v1", auth: authClient, retry: false });
    const accountEmail = await this.getFromAddress();
    try {
      // A send that may have reached Google is never retried on an ambiguous
      // network error, to avoid delivering the same email twice.
      const res = await withRetry(
        () =>
          raw.length <= RAW_JSON_LIMIT_BYTES
            ? gmail.users.messages.send({ userId: "me", requestBody: { raw: raw.toString("base64url") } })
            : gmail.users.messages.send({
                userId: "me",
                requestBody: {},
                media: { mimeType: "message/rfc822", body: Readable.from(raw) },
              }),
        { ...this.retry, allowAmbiguousNetwork: false },
      );
      const { id, threadId } = res.data;
      if (!id) throw new ToolError("UPSTREAM_ERROR", "Gmail accepted the request but returned no message id.");
      return { id, threadId: threadId ?? id, requestId: googleRequestId(res.headers) };
    } catch (err) {
      const mapped = mapGoogleError(err, { api: "gmail", accountEmail });
      if (mapped.code === "AUTH_REQUIRED") this.auth.invalidate();
      this.logger.debug("gmail send failed", { error_code: mapped.code, google_request_id: mapped.googleRequestId });
      throw mapped;
    }
  }
}
