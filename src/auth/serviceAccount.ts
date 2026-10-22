import { readFileSync } from "node:fs";
import { JWT, type OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { ToolError, mapGoogleError } from "../errors.js";
import type { Logger } from "../logger.js";
import { API_SCOPES, type AuthProvider, type AuthStatus, type GoogleApi } from "./provider.js";

interface ServiceAccountKey {
  type?: string;
  client_email?: string;
  private_key?: string;
}

/**
 * Service-account mode (Google Workspace only, §9.2). Docs work as the service
 * account itself (share the doc with its address) or as GOOGLE_IMPERSONATE_USER;
 * Gmail always needs domain-wide delegation plus GOOGLE_IMPERSONATE_USER.
 */
export class ServiceAccountProvider implements AuthProvider {
  readonly mode = "service_account" as const;
  private client?: JWT;
  private key?: ServiceAccountKey;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async getClient(api: GoogleApi): Promise<OAuth2Client> {
    const key = this.loadKey();
    const subject = this.config.google.impersonateUser;
    if (api === "gmail" && !subject) {
      throw new ToolError(
        "PERMISSION_DENIED",
        "Sending Gmail with a service account requires Google Workspace domain-wide delegation and GOOGLE_IMPERSONATE_USER set to the sending user's address. Personal @gmail.com accounts must use OAuth mode instead.",
      );
    }
    this.client ??= new JWT({ email: key.client_email, key: key.private_key, scopes: API_SCOPES, subject });
    return this.client;
  }

  async getUserEmail(): Promise<string | undefined> {
    try {
      return this.config.google.impersonateUser ?? this.loadKey().client_email;
    } catch {
      return undefined;
    }
  }

  async checkSetup(): Promise<string | undefined> {
    try {
      this.loadKey();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  invalidate(): void {
    this.client = undefined;
  }

  async status(): Promise<AuthStatus> {
    const base: AuthStatus = { authorized: false, auth_mode: this.mode, scopes: [] };
    let client: OAuth2Client;
    try {
      client = await this.getClient("docs");
    } catch (err) {
      return { ...base, instructions: (err as Error).message };
    }
    const email = await this.getUserEmail();
    try {
      await client.getAccessToken();
    } catch (err) {
      const mapped = mapGoogleError(err, { api: "docs" });
      this.logger.warn("service account token request failed", { error_code: mapped.code });
      return {
        ...base,
        email,
        instructions:
          "Google rejected the service-account credentials. Check the key file, and (when impersonating) that domain-wide delegation grants the gmail.send and documents scopes to this client ID.",
      };
    }
    const expiry = client.credentials.expiry_date;
    return {
      authorized: true,
      auth_mode: this.mode,
      email,
      scopes: [...API_SCOPES],
      ...(expiry ? { token_expires_at: new Date(expiry).toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
    };
  }

  private loadKey(): ServiceAccountKey {
    if (this.key) return this.key;
    const keyPath = this.config.google.serviceAccountKeyPath ?? "";
    let parsed: ServiceAccountKey;
    try {
      parsed = JSON.parse(readFileSync(keyPath, "utf8")) as ServiceAccountKey;
    } catch {
      throw new ToolError(
        "AUTH_REQUIRED",
        `Could not read the service-account key at GOOGLE_SERVICE_ACCOUNT_KEY_PATH (${keyPath}). Check the path and that the file is valid JSON.`,
      );
    }
    if (parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
      throw new ToolError(
        "AUTH_REQUIRED",
        "GOOGLE_SERVICE_ACCOUNT_KEY_PATH does not point to a service-account JSON key (expected type \"service_account\").",
      );
    }
    this.key = parsed;
    return parsed;
  }
}
