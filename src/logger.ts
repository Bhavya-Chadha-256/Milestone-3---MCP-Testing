import type { LogLevel } from "./config.js";

/**
 * Logger that writes JSON lines to stderr only. In stdio mode stdout carries the
 * MCP protocol, so nothing here may ever touch it (§5 rule 5).
 */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|credential|private[_-]?key|code_verifier|cookie)/i;
const CONTENT_KEY = /^(raw|body|text|content|content_base64|html)$/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const GOOGLE_TOKEN = /\b(ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{20,}|GOCSPX-[A-Za-z0-9_-]+)/g;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  isLevelEnabled(level: LogLevel): boolean;
}

export function redactString(value: string): string {
  return value.replace(BEARER, "$1 [REDACTED]").replace(GOOGLE_TOKEN, "[REDACTED]");
}

/** Deep-copies `value`, replacing secrets everywhere and message content unless `keepContent`. */
export function redact(value: unknown, keepContent = false, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, keepContent, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out[k] = "[REDACTED]";
    else if (!keepContent && CONTENT_KEY.test(k) && typeof v === "string") out[k] = `[${v.length} chars]`;
    else out[k] = redact(v, keepContent, depth + 1);
  }
  return out;
}

export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = LEVEL_ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    // Message content is only kept at debug level, and secrets are always redacted.
    const safe = fields ? (redact(fields, level === "debug") as LogFields) : {};
    const entry = { time: new Date().toISOString(), level: lvl, msg: redactString(msg), ...safe };
    try {
      write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Never let logging failures break a tool call.
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    isLevelEnabled: (lvl) => LEVEL_ORDER[lvl] >= threshold,
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  isLevelEnabled: () => false,
};

/** Reduce an email address to its domain for info-level logs (§12.5). */
export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "?" : address.slice(at + 1).toLowerCase();
}
