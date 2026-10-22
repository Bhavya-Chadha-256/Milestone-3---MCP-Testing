import { describe, expect, it } from "vitest";
import { blockedRecipients, domainMatches, isDocumentAllowed, isDomainAllowed } from "../../src/policy/allowlist.js";
import { Policy } from "../../src/policy/index.js";
import { SlidingWindowRateLimiter } from "../../src/policy/rateLimiter.js";
import { makeConfig } from "../helpers/fakes.js";

describe("domain allowlist", () => {
  it("matches case-insensitively", () => {
    expect(domainMatches("MyCompany.COM", "mycompany.com")).toBe(true);
    expect(domainMatches("mycompany.com", "MYCOMPANY.com")).toBe(true);
  });

  it("an exact entry does not match subdomains", () => {
    expect(domainMatches("eu.mycompany.com", "mycompany.com")).toBe(false);
  });

  it("a *. entry matches subdomains at any depth but not the apex", () => {
    expect(domainMatches("eu.mycompany.com", "*.mycompany.com")).toBe(true);
    expect(domainMatches("a.b.mycompany.com", "*.mycompany.com")).toBe(true);
    expect(domainMatches("mycompany.com", "*.mycompany.com")).toBe(false);
  });

  it("is not fooled by suffix tricks", () => {
    expect(domainMatches("evilmycompany.com", "*.mycompany.com")).toBe(false);
    expect(domainMatches("mycompany.com.evil.org", "mycompany.com")).toBe(false);
  });

  it("an empty list allows everything", () => {
    expect(isDomainAllowed("anything.org", [])).toBe(true);
    expect(blockedRecipients(["a@x.org"], [])).toEqual([]);
  });

  it("reports blocked recipients", () => {
    expect(blockedRecipients(["a@mycompany.com", "b@Partner.org", "c@gmail.com"], ["mycompany.com", "partner.org"])).toEqual([
      "c@gmail.com",
    ]);
  });

  it("document IDs match exactly", () => {
    expect(isDocumentAllowed("abc", ["abc", "def"])).toBe(true);
    expect(isDocumentAllowed("ABC", ["abc"])).toBe(false);
    expect(isDocumentAllowed("x", [])).toBe(true);
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("allows `limit` events per window, then reports when to retry", () => {
    let t = 0;
    const limiter = new SlidingWindowRateLimiter(2, 60_000, () => t);
    expect(limiter.tryAcquire().allowed).toBe(true);
    t = 10_000;
    expect(limiter.tryAcquire().allowed).toBe(true);
    t = 20_000;
    expect(limiter.tryAcquire()).toEqual({ allowed: false, retryAfterSeconds: 40 });
    t = 60_001; // the first event has left the window
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("is a sliding (not fixed) window", () => {
    let t = 59_000;
    const limiter = new SlidingWindowRateLimiter(1, 60_000, () => t);
    expect(limiter.tryAcquire().allowed).toBe(true);
    t = 61_000; // a fixed window would have reset at 60s
    expect(limiter.tryAcquire().allowed).toBe(false);
  });
});

describe("Policy", () => {
  it("enforces MAX_RECIPIENTS across to/cc/bcc", () => {
    const policy = new Policy(makeConfig({ MAX_RECIPIENTS: "3" }).policy);
    expect(() => policy.checkRecipients({ to: ["a@x.com"], cc: ["b@x.com"], bcc: ["c@x.com"] })).not.toThrow();
    expect(() => policy.checkRecipients({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: ["d@x.com"] })).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED" }),
    );
  });

  it("blocks recipients outside ALLOWED_RECIPIENT_DOMAINS, including bcc", () => {
    const policy = new Policy(makeConfig({ ALLOWED_RECIPIENT_DOMAINS: "mycompany.com" }).policy);
    expect(() => policy.checkRecipients({ to: ["a@mycompany.com"], cc: [], bcc: ["spy@evil.com"] })).toThrow(
      expect.objectContaining({ code: "POLICY_BLOCKED", message: expect.stringContaining("evil.com") }),
    );
  });

  it("rate-limits sends with RATE_LIMITED and retry_after_seconds", () => {
    const policy = new Policy(makeConfig({ RATE_LIMIT_EMAILS_PER_HOUR: "1" }).policy, () => 0);
    policy.acquireEmailSend();
    try {
      policy.acquireEmailSend();
      expect.fail("expected an error");
    } catch (err) {
      expect(err).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 3600 });
    }
  });

  it("REQUIRE_DRY_RUN_FIRST needs a matching dry run within 5 minutes", () => {
    let t = 0;
    const policy = new Policy(makeConfig({ REQUIRE_DRY_RUN_FIRST: "true" }).policy, () => t);
    expect(() => policy.checkDryRunRequirement("fp")).toThrow(expect.objectContaining({ code: "POLICY_BLOCKED" }));
    policy.recordDryRun("fp");
    t = 4 * 60_000;
    expect(() => policy.checkDryRunRequirement("fp")).not.toThrow();
    expect(() => policy.checkDryRunRequirement("other")).toThrow();
    t = 6 * 60_000;
    expect(() => policy.checkDryRunRequirement("fp")).toThrow();
  });
});
