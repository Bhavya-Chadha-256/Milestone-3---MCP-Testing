import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../server.js";
import type { ToolDeps } from "../tools/common.js";

/** stdio: stdout carries only JSON-RPC; all logging goes to stderr. */
export async function startStdio(deps: ToolDeps, streams: { stdin?: Readable; stdout?: Writable } = {}) {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport(streams.stdin, streams.stdout);
  await server.connect(transport);
  deps.logger.info("server started", { transport: "stdio" });
  return { server, close: () => server.close() };
}

