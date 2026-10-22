import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FakeAuth, authorizedStatus, connectClient, makeDeps } from "../helpers/fakes.js";

async function call(auth: FakeAuth) {
  const { client, close } = await connectClient(makeDeps({ auth }));
  try {
    const result = (await client.callTool({ name: "google_auth_status", arguments: {} })) as CallToolResult;
    return { result, text: (result.content[0] as { text: string }).text, structured: result.structuredContent };
  } finally {
    await close();
  }
}

describe("google_auth_status", () => {
  it("reports an authorized account with its scopes", async () => {
    const { result, text, structured } = await call(new FakeAuth());
    expect(result.isError).toBeFalsy();
    expect(structured).toEqual(authorizedStatus());
    expect(text).toContain("Authorized with Google as me@example.com (oauth)");
    expect(text).toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("reports authorized: false with instructions (not as an error)", async () => {
    const auth = new FakeAuth({
      authorized: false,
      auth_mode: "oauth",
      scopes: [],
      instructions: "Not authorized with Google. Run `npx -y gmail-gdocs-mcp auth` in a terminal.",
    });
    const { result, text, structured } = await call(auth);
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ authorized: false, instructions: expect.stringContaining("gmail-gdocs-mcp auth") });
    expect(text).toContain("npx -y gmail-gdocs-mcp auth");
  });
});
