import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthProvider } from "../auth/provider.js";
import type { Config } from "../config.js";
import { ToolError, mapGoogleError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Policy } from "../policy/index.js";
import type { DocsApi } from "../services/gdocs.js";
import type { EmailSender } from "../services/gmail.js";

/** Everything a tool handler needs; tests substitute fakes for the services. */
export interface ToolDeps {
  config: Config;
  logger: Logger;
  auth: AuthProvider;
  email: EmailSender;
  docs: DocsApi;
  policy: Policy;
  now?: () => Date;
}

export function successResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export function errorResult(err: ToolError): CallToolResult {
  const payload = err.toPayload();
  const retry = payload.retry_after_seconds !== undefined ? ` (retry after ${payload.retry_after_seconds}s)` : "";
  return {
    content: [{ type: "text", text: `Error ${payload.code}: ${payload.message}${retry}` }],
    structuredContent: { error: payload },
    isError: true,
  };
}

export interface ToolOutcome {
  result: CallToolResult;
  /** Extra non-sensitive fields for the info-level log line. */
  logFields?: Record<string, unknown>;
  googleRequestId?: string;
}

/**
 * Runs a tool body, converting every failure into a structured error result
 * (§11) and logging tool name, outcome and latency (§12.5).
 */
export async function runTool(
  name: string,
  logger: Logger,
  body: (log: Record<string, unknown>) => Promise<ToolOutcome>,
): Promise<CallToolResult> {
  const started = performance.now();
  const logFields: Record<string, unknown> = {};
  try {
    const outcome = await body(logFields);
    logger.info("tool call", {
      tool: name,
      outcome: "ok",
      latency_ms: Math.round(performance.now() - started),
      ...logFields,
      ...outcome.logFields,
      ...(outcome.googleRequestId ? { google_request_id: outcome.googleRequestId } : {}),
    });
    return outcome.result;
  } catch (err) {
    const toolError = err instanceof ToolError ? err : mapGoogleError(err, { api: "docs" });
    const level = toolError.code === "UPSTREAM_ERROR" ? "error" : "warn";
    logger[level]("tool call", {
      tool: name,
      outcome: toolError.code,
      latency_ms: Math.round(performance.now() - started),
      ...logFields,
      ...(toolError.googleRequestId ? { google_request_id: toolError.googleRequestId } : {}),
      ...(err instanceof ToolError ? {} : { error: err }),
    });
    return errorResult(toolError);
  }
}
