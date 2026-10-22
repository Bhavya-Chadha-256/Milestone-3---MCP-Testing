import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, assertHttpSecurity, loadConfig, parseCliArgs } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig({});
    expect(c.transport).toBe("stdio");
    expect(c.http).toMatchObject({ host: "127.0.0.1", port: 3000, allowUnauthenticated: false });
    expect(c.google.tokenPath).toBe(path.join(os.homedir(), ".config", "gmail-gdocs-mcp", "token.json"));
    expect(c.policy).toEqual({
      allowedRecipientDomains: [],
      allowedDocumentIds: [],
      maxRecipients: 50,
      maxAttachmentBytes: 10485760,
      emailsPerHour: 30,
      docAppendsPerMinute: 30,
      requireDryRunFirst: false,
    });
    expect(c.timezone).toBe("UTC");
    expect(c.logLevel).toBe("info");
  });

  it("parses lists, numbers and booleans", () => {
    const c = loadConfig({
      ALLOWED_RECIPIENT_DOMAINS: " MyCompany.com, partner.org ,",
      ALLOWED_DOCUMENT_IDS: "abc,def",
      MAX_RECIPIENTS: "5",
      MCP_ALLOW_UNAUTHENTICATED: "TRUE",
      GOOGLE_TOKEN_PATH: "~/tokens/t.json",
    });
    expect(c.policy.allowedRecipientDomains).toEqual(["mycompany.com", "partner.org"]);
    expect(c.policy.allowedDocumentIds).toEqual(["abc", "def"]);
    expect(c.policy.maxRecipients).toBe(5);
    expect(c.http.allowUnauthenticated).toBe(true);
    expect(c.google.tokenPath).toBe(path.join(os.homedir(), "tokens", "t.json"));
  });

  it("lets CLI flags override environment variables", () => {
    const c = loadConfig({ MCP_TRANSPORT: "stdio", PORT: "3000" }, { transport: "http", port: "8080", host: "0.0.0.0" });
    expect(c.transport).toBe("http");
    expect(c.http.port).toBe(8080);
    expect(c.http.host).toBe("0.0.0.0");
  });

  it.each([
    [{ MCP_TRANSPORT: "sse" }, "MCP_TRANSPORT"],
    [{ PORT: "abc" }, "PORT"],
    [{ PORT: "70000" }, "PORT"],
    [{ MAX_RECIPIENTS: "0" }, "MAX_RECIPIENTS"],
    [{ TIMEZONE: "Mars/Olympus" }, "TIMEZONE"],
    [{ LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
    [{ REQUIRE_DRY_RUN_FIRST: "maybe" }, "REQUIRE_DRY_RUN_FIRST"],
  ])("rejects invalid values (%o)", (env, field) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(field);
  });
});

describe("assertHttpSecurity", () => {
  it("refuses HTTP mode without MCP_AUTH_TOKEN", () => {
    expect(() => assertHttpSecurity(loadConfig({ MCP_TRANSPORT: "http" }))).toThrow(/requires MCP_AUTH_TOKEN/);
  });

  it("allows MCP_ALLOW_UNAUTHENTICATED only on loopback", () => {
    expect(() => assertHttpSecurity(loadConfig({ MCP_ALLOW_UNAUTHENTICATED: "true" }))).not.toThrow();
    expect(() => assertHttpSecurity(loadConfig({ MCP_ALLOW_UNAUTHENTICATED: "true", HOST: "0.0.0.0" }))).toThrow(
      /only permitted when binding to 127.0.0.1/,
    );
  });

  it("rejects short tokens and accepts long ones", () => {
    expect(() => assertHttpSecurity(loadConfig({ MCP_AUTH_TOKEN: "short" }))).toThrow(/too short/);
    expect(() => assertHttpSecurity(loadConfig({ MCP_AUTH_TOKEN: "x".repeat(32), HOST: "0.0.0.0" }))).not.toThrow();
  });
});

describe("parseCliArgs", () => {
  it("parses the auth subcommand and flags", () => {
    expect(parseCliArgs(["auth", "--no-browser"])).toMatchObject({ command: "auth", noBrowser: true });
    expect(parseCliArgs(["--transport", "http", "--port", "3001"])).toMatchObject({
      command: "serve",
      transport: "http",
      port: "3001",
    });
    expect(parseCliArgs(["--help"]).command).toBe("help");
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseCliArgs(["deploy"])).toThrow(ConfigError);
    expect(() => parseCliArgs(["--bogus"])).toThrow(ConfigError);
  });
});
