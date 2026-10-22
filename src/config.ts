import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_TOKEN_PATH = path.join(os.homedir(), ".config", "gmail-gdocs-mcp", "token.json");

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return fallback;
      const normalized = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      ctx.addIssue({ code: "custom", message: `expected true or false, got "${v}"` });
      return z.NEVER;
    });

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({ code: "custom", message: `expected a positive integer, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const timezone = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const tz = v && v.trim() !== "" ? v.trim() : "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      ctx.addIssue({ code: "custom", message: `unknown IANA time zone "${tz}"` });
      return z.NEVER;
    }
    return tz;
  });

const EnvSchema = z.object({
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_TOKEN_PATH: optionalString,
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: optionalString,
  GOOGLE_IMPERSONATE_USER: optionalString,
  MCP_TRANSPORT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim().toLowerCase() : "stdio"))
    .pipe(z.enum(["stdio", "http"])),
  HOST: optionalString,
  PORT: positiveInt(3000).pipe(z.number().max(65535)),
  MCP_AUTH_TOKEN: optionalString,
  MCP_ALLOW_UNAUTHENTICATED: bool(false),
  MCP_ALLOWED_ORIGINS: csv,
  MCP_ALLOWED_HOSTS: csv,
  ALLOWED_RECIPIENT_DOMAINS: csv,
  ALLOWED_DOCUMENT_IDS: csv,
  MAX_RECIPIENTS: positiveInt(50),
  MAX_ATTACHMENT_BYTES: positiveInt(10 * 1024 * 1024),
  RATE_LIMIT_EMAILS_PER_HOUR: positiveInt(30),
  RATE_LIMIT_DOC_APPENDS_PER_MINUTE: positiveInt(30),
  REQUIRE_DRY_RUN_FIRST: bool(false),
  TIMEZONE: timezone,
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim().toLowerCase() : "info"))
    .pipe(z.enum(LOG_LEVELS)),
});

export interface Config {
  google: {
    clientId?: string;
    clientSecret?: string;
    tokenPath: string;
    serviceAccountKeyPath?: string;
    impersonateUser?: string;
  };
  transport: "stdio" | "http";
  http: {
    host: string;
    port: number;
    authToken?: string;
    allowUnauthenticated: boolean;
    allowedOrigins: string[];
    allowedHosts: string[];
  };
  policy: {
    allowedRecipientDomains: string[];
    allowedDocumentIds: string[];
    maxRecipients: number;
    maxAttachmentBytes: number;
    emailsPerHour: number;
    docAppendsPerMinute: number;
    requireDryRunFirst: boolean;
  };
  timezone: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CliArgs {
  command: "serve" | "auth" | "help" | "version";
  transport?: string;
  port?: string;
  host?: string;
  noBrowser: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        transport: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        "no-browser": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1 || (positionals[0] && positionals[0] !== "auth")) {
    throw new ConfigError(`Unknown command "${positionals.join(" ")}". Run with --help for usage.`);
  }
  let command: CliArgs["command"] = positionals[0] === "auth" ? "auth" : "serve";
  if (values.help) command = "help";
  else if (values.version) command = "version";
  return {
    command,
    transport: values.transport,
    port: values.port,
    host: values.host,
    noBrowser: values["no-browser"] ?? false,
  };
}

/** Build the config from environment variables; CLI flags override env. */
export function loadConfig(env: NodeJS.ProcessEnv, cli: Partial<CliArgs> = {}): Config {
  const merged = {
    ...env,
    ...(cli.transport !== undefined ? { MCP_TRANSPORT: cli.transport } : {}),
    ...(cli.port !== undefined ? { PORT: cli.port } : {}),
    ...(cli.host !== undefined ? { HOST: cli.host } : {}),
  };
  const result = EnvSchema.safeParse(merged);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  const e = result.data;
  return {
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      tokenPath: expandHome(e.GOOGLE_TOKEN_PATH ?? DEFAULT_TOKEN_PATH),
      serviceAccountKeyPath: e.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && expandHome(e.GOOGLE_SERVICE_ACCOUNT_KEY_PATH),
      impersonateUser: e.GOOGLE_IMPERSONATE_USER,
    },
    transport: e.MCP_TRANSPORT,
    http: {
      host: e.HOST ?? "127.0.0.1",
      port: e.PORT,
      authToken: e.MCP_AUTH_TOKEN,
      allowUnauthenticated: e.MCP_ALLOW_UNAUTHENTICATED,
      allowedOrigins: e.MCP_ALLOWED_ORIGINS,
      allowedHosts: e.MCP_ALLOWED_HOSTS.map((h) => h.toLowerCase()),
    },
    policy: {
      allowedRecipientDomains: e.ALLOWED_RECIPIENT_DOMAINS.map((d) => d.toLowerCase()),
      allowedDocumentIds: e.ALLOWED_DOCUMENT_IDS,
      maxRecipients: e.MAX_RECIPIENTS,
      maxAttachmentBytes: e.MAX_ATTACHMENT_BYTES,
      emailsPerHour: e.RATE_LIMIT_EMAILS_PER_HOUR,
      docAppendsPerMinute: e.RATE_LIMIT_DOC_APPENDS_PER_MINUTE,
      requireDryRunFirst: e.REQUIRE_DRY_RUN_FIRST,
    },
    timezone: e.TIMEZONE,
    logLevel: e.LOG_LEVEL,
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * HTTP mode must not expose "send email as the user" without authentication (§9.4).
 * Throws a ConfigError describing how to fix the configuration.
 */
export function assertHttpSecurity(config: Config): void {
  const { authToken, allowUnauthenticated, host } = config.http;
  if (authToken) {
    if (authToken.length < 16) {
      throw new ConfigError(
        "MCP_AUTH_TOKEN is too short. Use at least 16 random characters, e.g. `openssl rand -hex 32`.",
      );
    }
    return;
  }
  if (allowUnauthenticated && isLoopbackHost(host)) return;
  if (allowUnauthenticated) {
    throw new ConfigError(
      `MCP_ALLOW_UNAUTHENTICATED=true is only permitted when binding to 127.0.0.1 or localhost (HOST is "${host}"). Set MCP_AUTH_TOKEN instead.`,
    );
  }
  throw new ConfigError(
    "HTTP mode requires MCP_AUTH_TOKEN (a long random string, e.g. `openssl rand -hex 32`). Clients must send `Authorization: Bearer <token>`. For local-only testing you may instead set MCP_ALLOW_UNAUTHENTICATED=true with HOST=127.0.0.1.",
  );
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
