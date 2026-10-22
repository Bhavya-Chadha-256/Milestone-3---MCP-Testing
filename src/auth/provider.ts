import type { OAuth2Client } from "google-auth-library";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";

/** The only API scopes this server ever needs (§9.1). */
export const API_SCOPES = [GMAIL_SEND_SCOPE, DOCS_SCOPE];

export const AUTH_COMMAND = "npx -y gmail-gdocs-mcp auth";

export type GoogleApi = "gmail" | "docs";

export interface AuthStatus {
  authorized: boolean;
  auth_mode: "oauth" | "service_account";
  email?: string;
  scopes: string[];
  missing_scopes?: string[];
  token_expires_at?: string;
  instructions?: string;
  warning?: string;
}

export interface AuthProvider {
  readonly mode: AuthStatus["auth_mode"];
  /** An authorized client for the given API, or throws ToolError(AUTH_REQUIRED | PERMISSION_DENIED). */
  getClient(api: GoogleApi): Promise<OAuth2Client>;
  /** The account email we act as, when known. Never throws. */
  getUserEmail(): Promise<string | undefined>;
  status(): Promise<AuthStatus>;
  /** Forget cached credentials so the next call reloads them (e.g. after a revoked token). */
  invalidate(): void;
}

export function missingScopes(granted: string[]): string[] {
  return API_SCOPES.filter((s) => !granted.includes(s));
}
