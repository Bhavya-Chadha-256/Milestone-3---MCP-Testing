import type { Config } from "../config.js";
import { ToolError, policyBlocked } from "../errors.js";
import { blockedRecipients, isDocumentAllowed } from "./allowlist.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

const DRY_RUN_TTL_MS = 5 * 60 * 1000;

/** Hard backstops for side-effectful tools (§3 G6, §12). One instance per server process. */
export class Policy {
  private readonly emailLimiter: SlidingWindowRateLimiter;
  private readonly docLimiter: SlidingWindowRateLimiter;
  /** Fingerprints of recent email dry runs, for REQUIRE_DRY_RUN_FIRST. */
  private readonly dryRuns = new Map<string, number>();

  constructor(
    readonly settings: Config["policy"],
    private readonly now: () => number = Date.now,
  ) {
    this.emailLimiter = new SlidingWindowRateLimiter(settings.emailsPerHour, 60 * 60 * 1000, now);
    this.docLimiter = new SlidingWindowRateLimiter(settings.docAppendsPerMinute, 60 * 1000, now);
  }

  /** Allowlist and recipient-count checks; applies to dry runs too, so a preview reveals a block. */
  checkRecipients(recipients: { to: string[]; cc: string[]; bcc: string[] }): void {
    const all = [...recipients.to, ...recipients.cc, ...recipients.bcc];
    if (all.length > this.settings.maxRecipients) {
      throw policyBlocked(
        `Too many recipients: ${all.length} across to/cc/bcc, the limit is ${this.settings.maxRecipients} (MAX_RECIPIENTS).`,
      );
    }
    const blocked = blockedRecipients(all, this.settings.allowedRecipientDomains);
    if (blocked.length > 0) {
      const domains = [...new Set(blocked.map((a) => a.slice(a.lastIndexOf("@") + 1).toLowerCase()))];
      throw policyBlocked(
        `Recipient domain(s) not allowed: ${domains.join(", ")}. This server only sends to: ${this.settings.allowedRecipientDomains.join(", ")} (ALLOWED_RECIPIENT_DOMAINS). Nothing was sent.`,
      );
    }
  }

  checkDocument(documentId: string): void {
    if (!isDocumentAllowed(documentId, this.settings.allowedDocumentIds)) {
      throw policyBlocked(
        `Document ${documentId} is not in this server's ALLOWED_DOCUMENT_IDS list. Ask the server operator to add it. Nothing was written.`,
      );
    }
  }

  recordDryRun(fingerprint: string): void {
    this.pruneDryRuns();
    this.dryRuns.set(fingerprint, this.now());
  }

  /** REQUIRE_DRY_RUN_FIRST: a real send needs an identical dry run in the last 5 minutes. */
  checkDryRunRequirement(fingerprint: string): void {
    if (!this.settings.requireDryRunFirst) return;
    this.pruneDryRuns();
    if (!this.dryRuns.has(fingerprint)) {
      throw policyBlocked(
        "This server requires a preview before sending (REQUIRE_DRY_RUN_FIRST). Call gmail_send_email with dry_run: true and identical arguments, show the preview to the user, then repeat the call with dry_run: false within 5 minutes.",
      );
    }
  }

  consumeDryRun(fingerprint: string): void {
    this.dryRuns.delete(fingerprint);
  }

  acquireEmailSend(): void {
    const decision = this.emailLimiter.tryAcquire();
    if (!decision.allowed) {
      throw new ToolError(
        "RATE_LIMITED",
        `Local email limit reached (${this.settings.emailsPerHour} per hour, RATE_LIMIT_EMAILS_PER_HOUR). Retry in ${decision.retryAfterSeconds}s.`,
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }
  }

  acquireDocAppend(): void {
    const decision = this.docLimiter.tryAcquire();
    if (!decision.allowed) {
      throw new ToolError(
        "RATE_LIMITED",
        `Local document append limit reached (${this.settings.docAppendsPerMinute} per minute, RATE_LIMIT_DOC_APPENDS_PER_MINUTE). Retry in ${decision.retryAfterSeconds}s.`,
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }
  }

  private pruneDryRuns() {
    const cutoff = this.now() - DRY_RUN_TTL_MS;
    for (const [fp, at] of this.dryRuns) if (at < cutoff) this.dryRuns.delete(fp);
  }
}
