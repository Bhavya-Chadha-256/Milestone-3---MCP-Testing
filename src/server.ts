import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAuthProvider } from "./auth/index.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { Policy } from "./policy/index.js";
import { GoogleDocsService } from "./services/gdocs.js";
import { GmailService } from "./services/gmail.js";
import type { ToolDeps } from "./tools/common.js";
import { registerGdocsAppendText } from "./tools/gdocsAppendText.js";
import { registerGmailSendEmail } from "./tools/gmailSendEmail.js";
import { registerGoogleAuthStatus } from "./tools/googleAuthStatus.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const SERVER_NAME = "gmail-gdocs-mcp";
export const SERVER_VERSION = pkg.version;

const INSTRUCTIONS =
  "Tools to send email from the user's Gmail account and append text to the end of existing Google Docs. " +
  "Only send email or edit documents when the user has explicitly asked for it; when unsure, call the tool with dry_run: true and show the preview first. " +
  "If a tool returns AUTH_REQUIRED, call google_auth_status and relay its instructions to the user.";

/** Shared, long-lived dependencies: one set per process, so rate limits apply across all sessions. */
export function createDefaultDeps(config: Config, logger: Logger): ToolDeps {
  const auth = createAuthProvider(config, logger);
  return {
    config,
    logger,
    auth,
    email: new GmailService(auth, logger),
    docs: new GoogleDocsService(auth, logger),
    policy: new Policy(config.policy),
  };
}

/** Builds an McpServer with exactly the three tools registered. Cheap; HTTP mode creates one per request. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerGmailSendEmail(server, deps);
  registerGdocsAppendText(server, deps);
  registerGoogleAuthStatus(server, deps);
  return server;
}
