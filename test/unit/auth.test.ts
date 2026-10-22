import { mkdtempSync, statSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OAuthProvider, OAUTH_SCOPES, emailFromIdToken } from "../../src/auth/oauth.js";
import { ServiceAccountProvider } from "../../src/auth/serviceAccount.js";
import { TokenStore } from "../../src/auth/tokenStore.js";
import { silentLogger } from "../../src/logger.js";
import { makeConfig } from "../helpers/fakes.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "gmail-gdocs-mcp-"));

describe("TokenStore", () => {
  it.skipIf(process.platform === "win32")("writes the token file with mode 0600 inside a 0700 directory", async () => {
    const file = path.join(tmp(), "nested", "token.json");
    const store = new TokenStore(file);
    await store.save({ refresh_token: "r", email: "me@example.com" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store.load()).toMatchObject({ refresh_token: "r", email: "me@example.com" });
  });

  it.skipIf(process.platform === "win32")("tightens an over-permissive existing file on load", async () => {
    const file = path.join(tmp(), "token.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);
    await new TokenStore(file).load();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("returns undefined for a missing file", async () => {
    expect(await new TokenStore(path.join(tmp(), "none.json")).load()).toBeUndefined();
  });
});

describe("OAuth", () => {
  it("requests only gmail.send, documents, openid and email", () => {
    expect(OAUTH_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/documents",
      "openid",
      "email",
    ]);
  });

  it("reads the email claim from an ID token", () => {
    const payload = Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url");
    expect(emailFromIdToken(`h.${payload}.s`)).toBe("me@example.com");
    expect(emailFromIdToken("garbage")).toBeUndefined();
    expect(emailFromIdToken(undefined)).toBeUndefined();
  });

  it("without client credentials: AUTH_REQUIRED explaining what to set", async () => {
    const provider = new OAuthProvider(makeConfig(), new TokenStore("/nonexistent/t.json"), silentLogger);
    await expect(provider.getClient("gmail")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("GOOGLE_CLIENT_ID"),
    });
    expect(await provider.status()).toMatchObject({ authorized: false, auth_mode: "oauth" });
  });

  it("without a token file: AUTH_REQUIRED with the exact command", async () => {
    const config = makeConfig({ GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" });
    const provider = new OAuthProvider(config, new TokenStore(path.join(tmp(), "t.json")), silentLogger);
    await expect(provider.getClient("docs")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("npx -y gmail-gdocs-mcp auth"),
    });
    const status = await provider.status();
    expect(status.authorized).toBe(false);
    expect(status.instructions).toContain("npx -y gmail-gdocs-mcp auth");
  });
});

describe("ServiceAccountProvider", () => {
  it("refuses Gmail without GOOGLE_IMPERSONATE_USER", async () => {
    const key = path.join(tmp(), "sa.json");
    writeFileSync(key, JSON.stringify({ type: "service_account", client_email: "sa@p.iam.gserviceaccount.com", private_key: "k" }));
    const provider = new ServiceAccountProvider(makeConfig({ GOOGLE_SERVICE_ACCOUNT_KEY_PATH: key }), silentLogger);
    await expect(provider.getClient("gmail")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await provider.getUserEmail()).toBe("sa@p.iam.gserviceaccount.com");
  });

  it("reports an unreadable key as AUTH_REQUIRED", async () => {
    const provider = new ServiceAccountProvider(makeConfig({ GOOGLE_SERVICE_ACCOUNT_KEY_PATH: "/nonexistent/sa.json" }), silentLogger);
    await expect(provider.getClient("docs")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect((await provider.status()).authorized).toBe(false);
  });
});

describe("runOAuthFlow (loopback + PKCE)", () => {
  async function startFlow() {
    const { runOAuthFlow } = await import("../../src/auth/oauth.js");
    const config = makeConfig({
      GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "s",
      GOOGLE_TOKEN_PATH: path.join(tmp(), "t.json"),
    });
    let printed = "";
    const flow = runOAuthFlow(config, { openBrowser: false, print: (l) => (printed += `${l}\n`), timeoutMs: 5000 });
    flow.catch(() => {}); // asserted below
    await vi.waitFor(() => expect(printed).toContain("https://accounts.google.com"));
    const authUrl = new URL(/https:\/\/accounts\.google\.com\S+/.exec(printed)?.[0] ?? "");
    return { flow, authUrl };
  }

  it("builds a consent URL with PKCE S256, offline access, a loopback redirect and only our scopes", async () => {
    const { flow, authUrl } = await startFlow();
    const p = authUrl.searchParams;
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(p.get("scope")?.split(" ")).toEqual(OAUTH_SCOPES);
    expect(p.get("state")).toMatch(/^[0-9a-f]{32}$/);
    // Finish the flow by simulating the user cancelling.
    await fetch(`${p.get("redirect_uri")}?error=access_denied&state=${p.get("state")}`);
    await expect(flow).rejects.toThrow(/access_denied/);
  });

  it("rejects a callback with the wrong state", async () => {
    const { flow, authUrl } = await startFlow();
    const res = await fetch(`${authUrl.searchParams.get("redirect_uri")}?code=abc&state=forged`);
    expect(res.status).toBe(400);
    await expect(flow).rejects.toThrow(/invalid state/);
  });
});
