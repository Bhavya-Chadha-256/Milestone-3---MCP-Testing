import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { assertHttpSecurity, isLoopbackHost } from "../config.js";
import { createMcpServer } from "../server.js";
import type { ToolDeps } from "../tools/common.js";

export const MCP_PATH = "/mcp";
const BODY_LIMIT = "15mb";
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
const CORS_ALLOW_HEADERS = "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID";

type RpcError = { code: number; message: string };

function jsonRpcError(res: Response, status: number, error: RpcError) {
  res.status(status).json({ jsonrpc: "2.0", error, id: null });
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest();
}

/** DNS-rebinding guard: when unauthenticated or MCP_ALLOWED_HOSTS is set, only loopback/listed Hosts pass. */
function hostCheck(deps: ToolDeps) {
  const { allowedHosts, authToken } = deps.config.http;
  const restrict = allowedHosts.length > 0 || !authToken;
  return (req: Request, res: Response, next: NextFunction) => {
    const host = hostnameOf(req.headers.host);
    if (!restrict || isLoopbackHost(host) || allowedHosts.includes(host)) return next();
    deps.logger.warn("rejected request with disallowed Host header", { host });
    jsonRpcError(res, 403, { code: -32000, message: "Forbidden: Host not allowed. Add it to MCP_ALLOWED_HOSTS." });
  };
}

/** Browser Origins must be loopback or in MCP_ALLOWED_ORIGINS; CORS is echoed only for those (never "*"). */
function originCheck(deps: ToolDeps) {
  const allowed = new Set(deps.config.http.allowedOrigins.map((o) => o.replace(/\/$/, "").toLowerCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser clients send no Origin
    const normalized = origin.replace(/\/$/, "").toLowerCase();
    if (LOOPBACK_ORIGIN.test(normalized) || allowed.has(normalized)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      return next();
    }
    deps.logger.warn("rejected request with disallowed Origin", { origin });
    jsonRpcError(res, 403, { code: -32000, message: "Forbidden: Origin not allowed. Add it to MCP_ALLOWED_ORIGINS." });
  };
}

function bearerAuth(authToken: string | undefined) {
  const expected = authToken ? tokenDigest(authToken) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return next(); // only reachable with MCP_ALLOW_UNAUTHENTICATED on loopback
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (match?.[1] && timingSafeEqual(tokenDigest(match[1].trim()), expected)) return next();
    res.setHeader("WWW-Authenticate", 'Bearer realm="gmail-gdocs-mcp"');
    jsonRpcError(res, 401, { code: -32001, message: "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>." });
  };
}

function corsPreflight(_req: Request, res: Response) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "600");
  res.status(204).end();
}

/** Stateless: a fresh McpServer per request, sharing the process-wide deps (so rate limits are global). */
function handleMcpPost(deps: ToolDeps) {
  return async (req: Request, res: Response) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      deps.logger.error("error handling MCP request", { error: err });
      if (!res.headersSent) jsonRpcError(res, 500, { code: -32603, message: "Internal server error" });
    }
  };
}

function methodNotAllowed(_req: Request, res: Response) {
  res.setHeader("Allow", "POST, OPTIONS");
  jsonRpcError(res, 405, { code: -32000, message: "Method not allowed. This server is stateless; use POST." });
}

function errorHandler(deps: ToolDeps) {
  // craftsman-ignore PARAM001 -- Express identifies error middleware by its 4-parameter arity.
  return (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number };
    if (e.type === "entity.too.large") {
      return jsonRpcError(res, 413, { code: -32600, message: `Request body exceeds ${BODY_LIMIT}.` });
    }
    if (e.type === "entity.parse.failed") return jsonRpcError(res, 400, { code: -32700, message: "Parse error: invalid JSON." });
    deps.logger.error("unhandled HTTP error", { error: err });
    jsonRpcError(res, e.status && e.status < 500 ? e.status : 500, { code: -32603, message: "Internal server error" });
  };
}

/**
 * Express app for Streamable HTTP (§9.4, §12.6): Host/Origin validation against
 * DNS rebinding, bearer auth, body size limit, and no wildcard CORS.
 */
export function createHttpApp(deps: ToolDeps) {
  assertHttpSecurity(deps.config);
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(MCP_PATH, hostCheck(deps), originCheck(deps));
  app.options(MCP_PATH, corsPreflight);
  app.use(MCP_PATH, bearerAuth(deps.config.http.authToken), express.json({ limit: BODY_LIMIT }));
  app.post(MCP_PATH, handleMcpPost(deps));
  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  app.all(MCP_PATH, methodNotAllowed);
  app.use(errorHandler(deps));
  return app;
}

export async function startHttp(deps: ToolDeps): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const app = createHttpApp(deps);
  const { host, port } = deps.config.http;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${shownHost}:${address.port}${MCP_PATH}`;
  deps.logger.info("server started", { transport: "http", url, authenticated: Boolean(deps.config.http.authToken) });
  return {
    server,
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
