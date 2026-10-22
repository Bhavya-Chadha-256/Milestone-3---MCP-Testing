import type { docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthProvider, AuthStatus } from "../../src/auth/provider.js";
import { loadConfig, type Config } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { Policy } from "../../src/policy/index.js";
import { createMcpServer } from "../../src/server.js";
import type { DocsApi } from "../../src/services/gdocs.js";
import type { EmailSender, GmailSendResult } from "../../src/services/gmail.js";
import type { ToolDeps } from "../../src/tools/common.js";

export function makeConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ GOOGLE_TOKEN_PATH: "/nonexistent/gmail-gdocs-mcp-test/token.json", ...env });
}

export class FakeAuth implements AuthProvider {
  readonly mode = "oauth" as const;
  constructor(public statusValue: AuthStatus = authorizedStatus()) {}
  async getClient(): Promise<OAuth2Client> {
    return {} as OAuth2Client;
  }
  async getUserEmail() {
    return this.statusValue.email;
  }
  async status() {
    return this.statusValue;
  }
  invalidate() {}
}

export function authorizedStatus(): AuthStatus {
  return {
    authorized: true,
    auth_mode: "oauth",
    email: "me@example.com",
    scopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/documents"],
    token_expires_at: "2026-10-22T14:03:00Z",
  };
}

export class FakeEmailSender implements EmailSender {
  sent: Buffer[] = [];
  error?: Error;
  constructor(private readonly from: string | undefined = "me@example.com") {}
  async getFromAddress() {
    return this.from;
  }
  async sendRaw(raw: Buffer): Promise<GmailSendResult> {
    if (this.error) throw this.error;
    this.sent.push(raw);
    return { id: "18f3c0ffee", threadId: "18f3c0ffee" };
  }
}

export class FakeDocsApi implements DocsApi {
  batches: Array<{ documentId: string; requests: docs_v1.Schema$Request[]; revision?: string }> = [];
  gets: Array<{ documentId: string; includeTabsContent: boolean }> = [];
  /** Errors thrown by successive batchUpdate calls (consumed in order). */
  batchErrors: Error[] = [];
  getError?: Error;
  constructor(public doc: docs_v1.Schema$Document = docWithParagraphs(["Existing line\n"])) {}
  async getDocument(documentId: string, includeTabsContent: boolean) {
    this.gets.push({ documentId, includeTabsContent });
    if (this.getError) throw this.getError;
    return this.doc;
  }
  async batchUpdate(documentId: string, requests: docs_v1.Schema$Request[], revision?: string) {
    const err = this.batchErrors.shift();
    if (err) throw err;
    this.batches.push({ documentId, requests, revision });
    return {};
  }
}

export const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";

/** A Docs body: section break at 0..1, then one paragraph per entry. */
export function bodyContent(
  paragraphs: Array<string | { text: string; bullet?: boolean }>,
): docs_v1.Schema$StructuralElement[] {
  const content: docs_v1.Schema$StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  let index = 1;
  for (const p of paragraphs) {
    const { text, bullet } = typeof p === "string" ? { text: p, bullet: false } : p;
    content.push({
      startIndex: index,
      endIndex: index + text.length,
      paragraph: {
        elements: [{ startIndex: index, endIndex: index + text.length, textRun: { content: text } }],
        ...(bullet ? { bullet: { listId: "kix.list1" } } : {}),
      },
    });
    index += text.length;
  }
  return content;
}

export function docWithParagraphs(paragraphs: Array<string | { text: string; bullet?: boolean }>): docs_v1.Schema$Document {
  return { documentId: DOC_ID, title: "Project Log", revisionId: "rev-1", body: { content: bodyContent(paragraphs) } };
}

export function makeDeps(overrides: Partial<ToolDeps> & { env?: Record<string, string> } = {}): ToolDeps & {
  email: FakeEmailSender;
  docs: FakeDocsApi;
} {
  const config = overrides.config ?? makeConfig(overrides.env);
  return {
    config,
    logger: silentLogger,
    auth: overrides.auth ?? new FakeAuth(),
    email: (overrides.email as FakeEmailSender) ?? new FakeEmailSender(),
    docs: (overrides.docs as FakeDocsApi) ?? new FakeDocsApi(),
    policy: overrides.policy ?? new Policy(config.policy),
    now: overrides.now ?? (() => new Date("2026-10-22T14:03:00Z")),
  };
}

/** An MCP client connected in-process to a server built from `deps`. */
export async function connectClient(deps: ToolDeps) {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => Promise.all([client.close(), server.close()]) };
}

/** Google API error shaped like a GaxiosError. */
export function googleError(
  status: number,
  options: { message?: string; reason?: string; status?: string; headers?: Record<string, string>; data?: unknown } = {},
) {
  const err = new Error(options.message ?? `HTTP ${status}`) as Error & Record<string, unknown>;
  err.status = status;
  err.response = {
    status,
    headers: options.headers ?? {},
    data: options.data ?? {
      error: {
        code: status,
        message: options.message ?? `HTTP ${status}`,
        status: options.status,
        errors: options.reason ? [{ reason: options.reason }] : [],
      },
    },
  };
  return err;
}
