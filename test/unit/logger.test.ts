import { describe, expect, it } from "vitest";
import { createLogger, emailDomain, redact } from "../../src/logger.js";

function capture(level: "debug" | "info") {
  const lines: string[] = [];
  const logger = createLogger(level, (l) => lines.push(l));
  return { logger, entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("logger", () => {
  it("writes one JSON object per line and respects the level", () => {
    const { logger, entries } = capture("info");
    logger.debug("hidden");
    logger.info("shown", { tool: "x" });
    expect(entries()).toEqual([expect.objectContaining({ level: "info", msg: "shown", tool: "x" })]);
  });

  it("redacts secrets at every level, including debug", () => {
    const { logger, entries } = capture("debug");
    logger.debug("call", {
      access_token: "ya29.abc",
      refresh_token: "1//xyz",
      client_secret: "GOCSPX-123",
      headers: { authorization: "Bearer abc.def" },
      note: "Authorization: Bearer abcdef123 and token ya29.leaky",
    });
    const text = JSON.stringify(entries());
    for (const secret of ["ya29.abc", "1//xyz", "GOCSPX-123", "abc.def", "abcdef123", "ya29.leaky"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("drops message content at info but keeps it at debug", () => {
    expect(redact({ body: "Dear Bob" })).toEqual({ body: "[8 chars]" });
    expect(redact({ body: "Dear Bob" }, true)).toEqual({ body: "Dear Bob" });
  });

  it("reduces addresses to domains", () => {
    expect(emailDomain("Alice@Example.COM")).toBe("example.com");
  });
});
