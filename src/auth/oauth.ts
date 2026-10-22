import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import type { Config } from "../config.js";
import { ToolError, extractGoogleErrorInfo } from "../errors.js";
import type { Logger } from "../logger.js";
import {
  API_SCOPES,
  AUTH_COMMAND,
  missingScopes,
  type AuthProvider,
  type AuthStatus,
  type GoogleApi,
} from "./provider.js";
import { TokenStore, type StoredToken } from "./tokenStore.js";

/**
 * Scopes requested during consent: the two API scopes plus the non-sensitive
 * `openid email`, so we learn the account address without a Gmail read scope (§9.1).
 */
export const OAUTH_SCOPES = [...API_SCOPES, "openid", "email"];

const CALLBACK_PATH = "/oauth2callback";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

const NOT_CONFIGURED =
  "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Create an OAuth client of type \"Desktop app\" in Google Cloud, add both values to this server's environment, then run `" +
  AUTH_COMMAND +
  "`.";

const NOT_AUTHORIZED = `Not authorized with Google. Run \`${AUTH_COMMAND}\` in a terminal (with the same GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_TOKEN_PATH as this server), then retry. For a deployed server (e.g. Render), run it on your own machine and upload the resulting token.json to the server's GOOGLE_TOKEN_PATH.`;

/** OAuth 2.0 user-credential mode: tokens from the loopback flow, refreshed automatically. */
export class OAuthProvider implements AuthProvider {
  readonly mode = "oauth" as const;
  private client?: OAuth2Client;
  private token?: StoredToken;
  private loadedMtime?: number;
  private persistFailureLogged = false;

  constructor(
    private readonly config: Config,
    private readonly store: TokenStore,
    private readonly logger: Logger,
  ) {}

  async getClient(_api: GoogleApi): Promise<OAuth2Client> {
    const { clientId, clientSecret } = this.config.google;
    if (!clientId || !clientSecret) throw new ToolError("AUTH_REQUIRED", NOT_CONFIGURED);

    const mtime = await this.store.mtime();
    if (this.client && mtime === this.loadedMtime) return this.client;

    const token = await this.store.load();
    if (!token || (!token.refresh_token && !token.access_token)) {
      this.client = undefined;
      throw new ToolError("AUTH_REQUIRED", NOT_AUTHORIZED);
    }
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expiry_date: token.expiry_date,
      token_type: token.token_type,
      scope: token.scope,
    });
    client.on("tokens", (fresh) => void this.persistRefreshed(fresh));
    this.client = client;
    this.token = token;
    this.loadedMtime = mtime;
    return client;
  }

  async checkSetup(): Promise<string | undefined> {
    const { clientId, clientSecret, tokenPath } = this.config.google;
    if (!clientId || !clientSecret) return NOT_CONFIGURED;
    let token: StoredToken | undefined;
    try {
      token = await this.store.load();
    } catch (err) {
      return `Cannot read the Google token file at ${tokenPath} (${(err as NodeJS.ErrnoException).code ?? "error"}). Check the path and file permissions.`;
    }
    if (!token) {
      return `No Google token file at ${tokenPath}. Run \`${AUTH_COMMAND}\` on a machine with a browser; for a deployed server (e.g. Render), upload the resulting token.json as a secret file at this path.`;
    }
    if (!token.refresh_token) {
      return `The token file at ${tokenPath} has no refresh token, so access will stop when the current access token expires. Re-run \`${AUTH_COMMAND}\`.`;
    }
    return undefined;
  }

  async getUserEmail(): Promise<string | undefined> {
    if (!this.token) {
      try {
        this.token = await this.store.load();
      } catch {
        return undefined;
      }
    }
    return this.token?.email;
  }

  invalidate(): void {
    this.client = undefined;
    this.loadedMtime = undefined;
  }

  async status(): Promise<AuthStatus> {
    const base = { auth_mode: this.mode, scopes: [] as string[] };
    let client: OAuth2Client;
    try {
      client = await this.getClient("docs");
    } catch (err) {
      const message = err instanceof ToolError ? err.message : NOT_AUTHORIZED;
      return { ...base, authorized: false, instructions: message };
    }
    const email = this.token?.email;
    let accessToken: string | null | undefined;
    try {
      accessToken = (await client.getAccessToken()).token;
    } catch (err) {
      const info = extractGoogleErrorInfo(err);
      if (info.oauthError || info.status === 400 || info.status === 401) {
        this.invalidate();
        return {
          ...base,
          authorized: false,
          email,
          instructions: `The stored Google authorization was revoked or has expired. ${NOT_AUTHORIZED}`,
        };
      }
      return this.offlineStatus(email, "Could not reach Google to refresh the access token; status is based on the stored token.");
    }

    let scopes = splitScopes(this.token?.scope);
    let expiresAt = client.credentials.expiry_date ?? undefined;
    try {
      const info = await client.getTokenInfo(accessToken ?? "");
      scopes = info.scopes;
      expiresAt = info.expiry_date;
    } catch {
      // Fall back to what was stored at authorization time.
    }
    return buildStatus({ authorized: true, email, scopes, expiresAt });
  }

  private offlineStatus(email: string | undefined, warning: string): AuthStatus {
    return buildStatus({
      authorized: Boolean(this.token?.refresh_token),
      email,
      scopes: splitScopes(this.token?.scope),
      expiresAt: this.token?.expiry_date,
      warning,
    });
  }

  private async persistRefreshed(fresh: Credentials) {
    const merged: StoredToken = {
      ...this.token,
      access_token: fresh.access_token ?? this.token?.access_token,
      refresh_token: fresh.refresh_token ?? this.token?.refresh_token,
      expiry_date: fresh.expiry_date ?? this.token?.expiry_date,
      token_type: fresh.token_type ?? this.token?.token_type,
      scope: fresh.scope ?? this.token?.scope,
    };
    try {
      await this.store.save(merged);
      this.token = merged;
      this.loadedMtime = await this.store.mtime();
      this.logger.debug("persisted refreshed Google access token");
    } catch (err) {
      // Expected on read-only mounts such as Render secret files: the refreshed
      // access token lives in memory and the stored refresh token keeps working.
      // Explain once, then stay quiet.
      if (this.persistFailureLogged) {
        this.logger.debug("could not persist refreshed token", { error: err });
        return;
      }
      this.persistFailureLogged = true;
      this.logger.warn(
        "could not persist refreshed token; keeping it in memory (expected when the token file is read-only, e.g. a Render secret file)",
        { error: err },
      );
    }
  }
}

function buildStatus(input: {
  authorized: boolean;
  email?: string;
  scopes: string[];
  expiresAt?: number;
  warning?: string;
}): AuthStatus {
  const missing = missingScopes(input.scopes);
  const status: AuthStatus = {
    authorized: input.authorized && missing.length === 0,
    auth_mode: "oauth",
    scopes: input.scopes,
  };
  if (input.email) status.email = input.email;
  if (input.expiresAt) status.token_expires_at = new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (missing.length > 0) {
    status.missing_scopes = missing;
    status.instructions = `The authorization is missing required scopes. Run \`${AUTH_COMMAND}\` again and grant every requested permission.`;
  }
  if (input.warning) status.warning = input.warning;
  return status;
}

function splitScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

/** Read the `email` claim from an ID token received directly from Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthFlowOptions {
  openBrowser?: boolean;
  /** Where to print progress for the human running the command. Defaults to stderr. */
  print?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * `gmail-gdocs-mcp auth`: loopback redirect on 127.0.0.1 (random port) + PKCE (§9.3).
 * Saves tokens with mode 0600 and returns the authorized account email.
 */
export async function runOAuthFlow(config: Config, options: AuthFlowOptions = {}): Promise<StoredToken> {
  const print = options.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { clientId, clientSecret, tokenPath } = config.google;
  if (!clientId || !clientSecret) throw new Error(NOT_CONFIGURED);

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  try {
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(16).toString("hex");
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: OAUTH_SCOPES,
      include_granted_scopes: false,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
      state,
    });

    print("Open this URL in your browser to authorize gmail-gdocs-mcp:\n");
    print(`  ${authUrl}\n`);
    if (options.openBrowser !== false) openInBrowser(authUrl);
    print("Waiting for Google to redirect back (Ctrl+C to cancel)...");

    const code = await waitForCode(server, state, options.timeoutMs ?? AUTH_TIMEOUT_MS);
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });

    const granted = splitScopes(tokens.scope ?? undefined);
    const missing = missingScopes(granted);
    if (missing.length > 0) {
      throw new Error(
        `Google did not grant: ${missing.join(", ")}. Run the command again and tick every permission on the consent screen.`,
      );
    }
    if (!tokens.refresh_token) {
      print("Warning: Google did not return a refresh token; you will need to re-run auth when the access token expires.");
    }
    const stored: StoredToken = {
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      scope: tokens.scope ?? undefined,
      token_type: tokens.token_type ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      email: emailFromIdToken(tokens.id_token),
    };
    await new TokenStore(tokenPath).save(stored);
    print(`\nAuthorized${stored.email ? ` as ${stored.email}` : ""}. Tokens saved to ${tokenPath} (mode 0600).`);
    return stored;
  } finally {
    server.close();
  }
}

function waitForCode(server: http.Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the Google authorization redirect.")), timeoutMs);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const finish = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>gmail-gdocs-mcp</title><p>${message}</p>`);
      };
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      clearTimeout(timer);
      if (error) {
        finish(false, "Authorization was not completed. You can close this tab.");
        reject(new Error(`Google returned "${error}". Authorization was not completed.`));
      } else if (url.searchParams.get("state") !== expectedState || !code) {
        finish(false, "Invalid authorization response. You can close this tab and try again.");
        reject(new Error("The authorization response had an invalid state parameter; aborting for safety."));
      } else {
        finish(true, "Authorization complete. You can close this tab and return to the terminal.");
        resolve(code);
      }
    });
  });
}

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed, so the user can open it by hand.
  }
}
