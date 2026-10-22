/**
 * Error model (§11). Every failure a tool can hit is converted into a ToolError
 * with one of a fixed set of codes, so any model can reason about it.
 */

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "POLICY_BLOCKED",
  "RATE_LIMITED",
  "CONFLICT",
  "UPSTREAM_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  AUTH_REQUIRED: false,
  PERMISSION_DENIED: false,
  NOT_FOUND: false,
  POLICY_BLOCKED: false,
  RATE_LIMITED: true,
  CONFLICT: true,
  UPSTREAM_ERROR: true,
};

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** Google request ID, when the error came from a Google API response. */
  readonly googleRequestId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryAfterSeconds?: number; googleRequestId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.googleRequestId = options.googleRequestId;
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterSeconds !== undefined) payload.retry_after_seconds = this.retryAfterSeconds;
    return payload;
  }
}

export const invalidArgument = (message: string) => new ToolError("INVALID_ARGUMENT", message);
export const policyBlocked = (message: string) => new ToolError("POLICY_BLOCKED", message);

/** Context used to make mapped Google errors actionable. */
export interface GoogleErrorContext {
  /** "gmail" or "docs": which API was being called. */
  api: "gmail" | "docs";
  /** Document ID for Docs calls. */
  documentId?: string;
  /** Authenticated account, used in sharing instructions. */
  accountEmail?: string;
}

/** The parts of a Google API (gaxios) error we care about, read defensively. */
export interface GoogleErrorInfo {
  status?: number;
  /** Google's canonical status string, e.g. "PERMISSION_DENIED", "FAILED_PRECONDITION". */
  googleStatus?: string;
  /** First `errors[].reason`, e.g. "rateLimitExceeded", "insufficientPermissions". */
  reason?: string;
  /** OAuth token endpoint error, e.g. "invalid_grant". */
  oauthError?: string;
  message?: string;
  retryAfterSeconds?: number;
  requestId?: string;
  /** Network error code such as ECONNRESET, when there was no HTTP response. */
  networkCode?: string;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/** Google request ID from response headers (plain object or fetch Headers), for logs. */
export function googleRequestId(headers: unknown): string | undefined {
  return readHeader(headers, "x-goog-request-id") ?? readHeader(headers, "x-request-id");
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "TimeoutError",
  "AbortError",
]);

/** Network failures where the request certainly never reached Google (safe to retry anything). */
export const PRE_CONNECT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function extractGoogleErrorInfo(err: unknown): GoogleErrorInfo {
  const info: GoogleErrorInfo = {};
  if (!err || typeof err !== "object") return info;
  const e = err as Record<string, any>;
  const response = e.response as Record<string, any> | undefined;

  const status = response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  if (typeof status === "number") info.status = status;

  const data = response?.data;
  if (data && typeof data === "object") {
    if (data.error && typeof data.error === "object") {
      info.googleStatus = typeof data.error.status === "string" ? data.error.status : undefined;
      info.message = typeof data.error.message === "string" ? data.error.message : undefined;
      const first = Array.isArray(data.error.errors) ? data.error.errors[0] : undefined;
      if (first && typeof first.reason === "string") info.reason = first.reason;
      info.reason ??= firstDetailReason(data.error.details);
    } else if (typeof data.error === "string") {
      info.oauthError = data.error;
      info.message = typeof data.error_description === "string" ? data.error_description : undefined;
    }
  }
  if (!info.message && typeof e.message === "string") info.message = e.message;

  info.retryAfterSeconds = parseRetryAfter(readHeader(response?.headers, "retry-after"));
  info.requestId = googleRequestId(response?.headers);

  if (info.status === undefined) {
    const code = typeof e.code === "string" ? e.code : (e.cause as any)?.code;
    const name = (e.cause as any)?.name ?? e.name;
    if (typeof code === "string" && NETWORK_CODES.has(code)) info.networkCode = code;
    else if (typeof name === "string" && NETWORK_CODES.has(name)) info.networkCode = name;
  }
  return info;
}

function firstDetailReason(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const found = details.find((d) => d && typeof d.reason === "string");
  return found?.reason;
}

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "RATE_LIMIT_EXCEEDED",
]);

function isRevisionConflict(info: GoogleErrorInfo): boolean {
  if (info.status === 409) return true;
  if (info.status === 400 && info.message && /revision/i.test(info.message)) return true;
  return info.googleStatus === "ABORTED";
}

function authRequired(cause: unknown, detail: string) {
  return new ToolError(
    "AUTH_REQUIRED",
    `${detail} Run \`npx -y gmail-gdocs-mcp auth\` in a terminal (with the same GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_TOKEN_PATH as this server), then retry.`,
    { cause },
  );
}

type ErrorOpts = { googleRequestId?: string; cause: unknown };

/**
 * Map any error thrown while talking to Google into a ToolError.
 * Messages never include tokens, secrets, or message bodies: only Google's short
 * error message plus our own guidance.
 */
export function mapGoogleError(err: unknown, ctx: GoogleErrorContext): ToolError {
  if (err instanceof ToolError) return err;
  const info = extractGoogleErrorInfo(err);
  const opts: ErrorOpts = { googleRequestId: info.requestId, cause: err };

  const oauth = mapOAuthError(info, err);
  if (oauth) return oauth;

  const doc = ctx.documentId ? `document ${ctx.documentId}` : "the document";
  switch (info.status) {
    case 400:
      if (ctx.api === "docs" && isRevisionConflict(info)) {
        return new ToolError("CONFLICT", `${cap(doc)} was modified while appending. Retry the call.`, opts);
      }
      return new ToolError("INVALID_ARGUMENT", `Google rejected the request as invalid.${googleSays(info)}`, opts);
    case 401:
      return authRequired(err, "Google reports the server's credentials are invalid or expired.");
    case 403:
      return mapForbidden(info, ctx, opts);
    case 404:
      return mapNotFound(info, ctx, opts);
    case 409:
      return new ToolError("CONFLICT", `${cap(doc)} was modified concurrently. Retry the call.`, opts);
    case 429:
      return new ToolError("RATE_LIMITED", "Google API rate limit reached. Wait and retry.", {
        ...opts,
        retryAfterSeconds: info.retryAfterSeconds,
      });
  }
  return mapOther(info, err, opts);
}

function googleSays(info: GoogleErrorInfo) {
  return info.message ? ` Google said: ${truncate(info.message, 200)}` : "";
}

function accountOf(ctx: GoogleErrorContext) {
  return ctx.accountEmail ?? "the authorized Google account";
}

function mapOAuthError(info: GoogleErrorInfo, err: unknown): ToolError | undefined {
  if (info.oauthError === "invalid_grant" || info.oauthError === "unauthorized_client") {
    return authRequired(err, "Google rejected the stored refresh token (it was revoked or has expired).");
  }
  if (info.oauthError === "invalid_client") {
    return authRequired(err, "Google rejected the OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  return undefined;
}

function mapForbidden(info: GoogleErrorInfo, ctx: GoogleErrorContext, opts: ErrorOpts): ToolError {
  if (info.reason && RATE_LIMIT_REASONS.has(info.reason)) {
    return new ToolError("RATE_LIMITED", `Google API quota exceeded. Wait and retry.${googleSays(info)}`, {
      ...opts,
      retryAfterSeconds: info.retryAfterSeconds,
    });
  }
  if (info.reason === "insufficientPermissions" || /scope/i.test(info.message ?? "")) {
    return new ToolError(
      "PERMISSION_DENIED",
      "The stored Google authorization is missing a required scope. Run `npx -y gmail-gdocs-mcp auth` again and grant every requested permission.",
      opts,
    );
  }
  if (info.reason === "accessNotConfigured" || info.reason === "SERVICE_DISABLED") {
    const apiName = ctx.api === "gmail" ? "Gmail API" : "Google Docs API";
    return new ToolError(
      "PERMISSION_DENIED",
      `The ${apiName} is not enabled for this Google Cloud project. Enable it in the Google Cloud console (APIs & Services > Library), wait a minute, and retry.`,
      opts,
    );
  }
  if (ctx.api === "docs") {
    const doc = ctx.documentId ? `document ${ctx.documentId}` : "the document";
    return new ToolError(
      "PERMISSION_DENIED",
      `The authenticated account cannot edit ${doc}. Share it with ${accountOf(ctx)} as an Editor, then retry.`,
      opts,
    );
  }
  return new ToolError(
    "PERMISSION_DENIED",
    `Gmail refused to send as ${accountOf(ctx)}.${googleSays(info)} Check that the account may send mail through the Gmail API.`,
    opts,
  );
}

function mapNotFound(info: GoogleErrorInfo, ctx: GoogleErrorContext, opts: ErrorOpts): ToolError {
  if (ctx.api === "gmail") return new ToolError("NOT_FOUND", `Gmail returned "not found".${googleSays(info)}`, opts);
  const doc = ctx.documentId ? `Document ${ctx.documentId}` : "The document";
  return new ToolError(
    "NOT_FOUND",
    `${doc} was not found or is not visible to ${accountOf(ctx)}. Check the ID or URL, and that the document is shared with that account.`,
    opts,
  );
}

function mapOther(info: GoogleErrorInfo, err: unknown, opts: ErrorOpts): ToolError {
  if (info.status !== undefined && info.status >= 500) {
    return new ToolError("UPSTREAM_ERROR", `Google returned HTTP ${info.status}. Retry shortly.`, opts);
  }
  if (info.networkCode) {
    return new ToolError("UPSTREAM_ERROR", `Network error talking to Google (${info.networkCode}). Retry shortly.`, opts);
  }
  if (info.status !== undefined) {
    return new ToolError("UPSTREAM_ERROR", `Unexpected HTTP ${info.status} from Google.${googleSays(info)}`, opts);
  }
  return new ToolError("UPSTREAM_ERROR", `Unexpected error: ${truncate(info.message ?? String(err), 200)}`, opts);
}

/** Whether an error is worth retrying internally (§11: 429 / 5xx / network). */
export function isTransientGoogleError(err: unknown, { allowAmbiguousNetwork }: { allowAmbiguousNetwork: boolean }) {
  const info = extractGoogleErrorInfo(err);
  if (info.status === 429) return true;
  if (info.status === 403 && info.reason && RATE_LIMIT_REASONS.has(info.reason)) return true;
  if (info.status !== undefined && info.status >= 500) return true;
  if (info.networkCode) return allowAmbiguousNetwork || PRE_CONNECT_NETWORK_CODES.has(info.networkCode);
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Retry network errors where the request may already have reached Google.
   * Disable for non-idempotent calls such as sending email.
   */
  allowAmbiguousNetwork?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter; at most `attempts` (default 3) tries in total. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    allowAmbiguousNetwork = true,
    sleep = defaultSleep,
    random = Math.random,
  } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransientGoogleError(err, { allowAmbiguousNetwork })) throw err;
      const retryAfter = extractGoogleErrorInfo(err).retryAfterSeconds;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = retryAfter !== undefined ? Math.min(maxDelayMs, retryAfter * 1000) : random() * backoff;
      await sleep(delay);
    }
  }
  throw lastError;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
