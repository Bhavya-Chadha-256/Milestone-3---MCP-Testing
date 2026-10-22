import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool, successResult, type ToolDeps } from "./common.js";

export const GOOGLE_AUTH_STATUS = "google_auth_status";

export const googleAuthStatusOutput = {
  authorized: z.boolean(),
  auth_mode: z.enum(["oauth", "service_account"]),
  email: z.string().optional().describe("Account the server acts as."),
  scopes: z.array(z.string()).describe("Scopes granted to the stored credentials."),
  missing_scopes: z.array(z.string()).optional(),
  token_expires_at: z.string().optional().describe("Access-token expiry (ISO-8601). It is refreshed automatically."),
  instructions: z.string().optional().describe("What to do next when not authorized."),
  warning: z.string().optional(),
};

export async function handleGoogleAuthStatus(deps: ToolDeps) {
  return runTool(GOOGLE_AUTH_STATUS, deps.logger, async (log) => {
    const status = await deps.auth.status();
    log.authorized = status.authorized;
    const text = status.authorized
      ? `Authorized with Google${status.email ? ` as ${status.email}` : ""} (${status.auth_mode}). Scopes: ${status.scopes.join(", ")}.${status.token_expires_at ? ` Access token expires ${status.token_expires_at} and refreshes automatically.` : ""}${status.warning ? ` Warning: ${status.warning}` : ""}`
      : `Not authorized with Google. ${status.instructions ?? ""}`.trim();
    return { result: successResult(text, { ...status }) };
  });
}

export function registerGoogleAuthStatus(server: McpServer, deps: ToolDeps) {
  server.registerTool(
    GOOGLE_AUTH_STATUS,
    {
      title: "Google auth status",
      description:
        "Check whether the server is authorized with Google and which account and scopes are active. Read-only.",
      outputSchema: googleAuthStatusOutput,
      annotations: {
        title: "Google auth status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => handleGoogleAuthStatus(deps),
  );
}
