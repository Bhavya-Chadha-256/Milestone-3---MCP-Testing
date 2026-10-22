import { describe, expect, it, vi } from "vitest";
import { ToolError, mapGoogleError, withRetry } from "../../src/errors.js";
import { googleError } from "../helpers/fakes.js";

const docsCtx = { api: "docs" as const, documentId: "DOC123", accountEmail: "me@example.com" };
const gmailCtx = { api: "gmail" as const, accountEmail: "me@example.com" };

describe("mapGoogleError", () => {
  it.each([
    [400, "INVALID_ARGUMENT", false],
    [401, "AUTH_REQUIRED", false],
    [403, "PERMISSION_DENIED", false],
    [404, "NOT_FOUND", false],
    [409, "CONFLICT", true],
    [429, "RATE_LIMITED", true],
    [500, "UPSTREAM_ERROR", true],
    [503, "UPSTREAM_ERROR", true],
  ])("maps HTTP %i to %s", (status, code, retryable) => {
    const mapped = mapGoogleError(googleError(status), docsCtx);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped.code).toBe(code);
    expect(mapped.retryable).toBe(retryable);
  });

  it("gives an actionable sharing message for a Docs 403", () => {
    const mapped = mapGoogleError(googleError(403, { message: "The caller does not have permission" }), docsCtx);
    expect(mapped.message).toBe(
      "The authenticated account cannot edit document DOC123. Share it with me@example.com as an Editor, then retry.",
    );
  });

  it("explains a missing scope and a disabled API", () => {
    expect(mapGoogleError(googleError(403, { reason: "insufficientPermissions" }), gmailCtx).message).toMatch(/gmail-gdocs-mcp auth` again/);
    expect(mapGoogleError(googleError(403, { reason: "accessNotConfigured" }), gmailCtx).message).toMatch(/Gmail API is not enabled/);
  });

  it("treats 403 quota reasons as RATE_LIMITED", () => {
    expect(mapGoogleError(googleError(403, { reason: "userRateLimitExceeded" }), gmailCtx).code).toBe("RATE_LIMITED");
  });

  it("passes Retry-After through", () => {
    const mapped = mapGoogleError(googleError(429, { headers: { "retry-after": "17" } }), gmailCtx);
    expect(mapped.toPayload()).toEqual(expect.objectContaining({ retry_after_seconds: 17, retryable: true }));
  });

  it("reads fetch-style Headers objects", () => {
    const mapped = mapGoogleError(googleError(429, { headers: new Headers({ "Retry-After": "5" }) as never }), gmailCtx);
    expect(mapped.retryAfterSeconds).toBe(5);
  });

  it("treats a Docs 400 about the revision as CONFLICT", () => {
    const err = googleError(400, { message: "The required revision ID does not match the latest revision." });
    expect(mapGoogleError(err, docsCtx).code).toBe("CONFLICT");
  });

  it("maps a revoked refresh token to AUTH_REQUIRED with the auth command", () => {
    const err = googleError(400, { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    const mapped = mapGoogleError(err, gmailCtx);
    expect(mapped.code).toBe("AUTH_REQUIRED");
    expect(mapped.message).toContain("npx -y gmail-gdocs-mcp auth");
  });

  it("maps network failures to UPSTREAM_ERROR", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(mapGoogleError(err, gmailCtx)).toMatchObject({ code: "UPSTREAM_ERROR", retryable: true });
  });

  it("never leaks secrets from the original error into the message", () => {
    const err = Object.assign(googleError(401), { config: { headers: { Authorization: "Bearer ya29.secret" } } });
    expect(mapGoogleError(err, gmailCtx).message).not.toContain("ya29");
  });
});

describe("withRetry", () => {
  const noSleep = { sleep: async () => {}, random: () => 0 };

  it("retries 429 and 5xx up to 3 attempts in total", async () => {
    const fn = vi.fn().mockRejectedValue(googleError(503));
    await expect(withRetry(fn, noSleep)).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("returns as soon as an attempt succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(googleError(429)).mockResolvedValue("ok");
    await expect(withRetry(fn, noSleep)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(googleError(403));
    await expect(withRetry(fn, noSleep)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff with jitter, honouring Retry-After", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    const fn = vi.fn().mockRejectedValue(googleError(500));
    await withRetry(fn, { sleep, random: () => 1, baseDelayMs: 100 }).catch(() => {});
    expect(delays).toEqual([100, 200]);
    delays.length = 0;
    await withRetry(vi.fn().mockRejectedValue(googleError(429, { headers: { "retry-after": "2" } })), { sleep }).catch(() => {});
    expect(delays).toEqual([2000, 2000]);
  });

  it("skips ambiguous network errors for non-idempotent calls, but retries pre-connect ones", async () => {
    const reset = vi.fn().mockRejectedValue(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await withRetry(reset, { ...noSleep, allowAmbiguousNetwork: false }).catch(() => {});
    expect(reset).toHaveBeenCalledTimes(1);
    const dns = vi.fn().mockRejectedValue(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }));
    await withRetry(dns, { ...noSleep, allowAmbiguousNetwork: false }).catch(() => {});
    expect(dns).toHaveBeenCalledTimes(3);
  });
});
