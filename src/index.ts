#!/usr/bin/env node
import dotenv from "dotenv";
import { runOAuthFlow } from "./auth/oauth.js";
import type { AuthProvider } from "./auth/provider.js";
import { ConfigError, loadConfig, parseCliArgs, type CliArgs, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { SERVER_NAME, SERVER_VERSION, createDefaultDeps } from "./server.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

Usage:
  ${SERVER_NAME}                       Start the MCP server (stdio by default)
  ${SERVER_NAME} --transport http      Start the Streamable HTTP server on /mcp
  ${SERVER_NAME} auth [--no-browser]   Authorize with Google and save tokens

Options:
  --transport <stdio|http>   Overrides MCP_TRANSPORT
  --port <n>                 Overrides PORT (HTTP mode)
  --host <addr>              Overrides HOST (HTTP mode)
  -h, --help                 Show this help
  -v, --version              Show the version

Configuration is read from environment variables (and a .env file in the
current directory). See README.md for the full list.
`;

// Usage, errors and auth progress all go to stderr: in stdio mode stdout is reserved for JSON-RPC.
const err = (line: string) => process.stderr.write(`${line}\n`);

async function runAuth(config: Config, cli: CliArgs) {
  if (config.google.serviceAccountKeyPath) {
    err("Service-account mode is configured (GOOGLE_SERVICE_ACCOUNT_KEY_PATH); no interactive authorization is needed.");
    return;
  }
  await runOAuthFlow(config, { openBrowser: !cli.noBrowser });
}

/** Startup log line saying whether Google credentials look usable (offline check). */
async function reportCredentialSetup(auth: AuthProvider, logger: Logger) {
  const problem = await auth.checkSetup();
  if (problem) logger.warn("google credentials not ready; tools will return AUTH_REQUIRED", { problem });
  else logger.info("google credentials found", { auth_mode: auth.mode });
}

async function serve(config: Config, logger: Logger) {
  const deps = createDefaultDeps(config, logger);
  const running = config.transport === "http" ? await startHttp(deps) : await startStdio(deps);
  await reportCredentialSetup(deps.auth, logger);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    void running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (config.transport === "stdio") process.stdin.on("end", () => shutdown("stdin closed"));
}

async function main() {
  dotenv.config({ quiet: true });
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.command === "help") return err(USAGE);
  if (cli.command === "version") return err(SERVER_VERSION);

  const config = loadConfig(process.env, cli);
  const logger = createLogger(config.logLevel);
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { error: reason }));

  if (cli.command === "auth") return runAuth(config, cli);
  await serve(config, logger);
}

main().catch((e: unknown) => {
  err(e instanceof ConfigError ? e.message : `Fatal: ${(e as Error)?.message ?? String(e)}`);
  process.exit(1);
});
