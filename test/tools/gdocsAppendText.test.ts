import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mapGoogleError } from "../../src/errors.js";
import { DOC_ID, FakeDocsApi, connectClient, docWithParagraphs, googleError, makeDeps } from "../helpers/fakes.js";

async function call(args: Record<string, unknown>, deps = makeDeps()) {
  const { client, close } = await connectClient(deps);
  try {
    const result = (await client.callTool({ name: "gdocs_append_text", arguments: args })) as CallToolResult;
    return { result, deps, text: (result.content[0] as { text: string }).text, structured: result.structuredContent as any };
  } finally {
    await close();
  }
}

const url = `https://docs.google.com/document/d/${DOC_ID}/edit`;

describe("gdocs_append_text", () => {
  it("appends text and returns text plus structuredContent", async () => {
    const { result, deps, text, structured } = await call({ document: url, text: "Shipped v1." });
    expect(result.isError).toBeFalsy();
    expect(structured).toEqual({
      status: "appended",
      document_id: DOC_ID,
      title: "Project Log",
      document_url: url,
      inserted_start_index: 14,
      inserted_end_index: 26,
      characters_appended: 12,
      separator_added: true,
    });
    expect(text).toBe(`Appended 12 characters to "Project Log" (indexes 14-26). ${url}`);
    expect(deps.docs.batches[0]?.requests[0]).toEqual({ insertText: { location: { index: 14 }, text: "\nShipped v1." } });
  });

  it("appends a heading then a bullet list at the end (§16.4)", async () => {
    const docs = new FakeDocsApi(docWithParagraphs(["Existing line\n"]));
    const deps = makeDeps({ docs });
    await call({ document: DOC_ID, text: "Status", paragraph_style: "HEADING_2" }, deps);
    // Simulate the document after the first append.
    docs.doc = docWithParagraphs(["Existing line\n", "Status\n"]);
    await call({ document: DOC_ID, text: "one\ntwo", as_bullets: true }, deps);

    const [heading, bullets] = docs.batches;
    expect(heading?.requests.find((r) => r.updateParagraphStyle)?.updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe("HEADING_2");
    expect(bullets?.requests[0]?.insertText).toEqual({ location: { index: 21 }, text: "\none\ntwo" });
    expect(bullets?.requests.find((r) => r.updateParagraphStyle)?.updateParagraphStyle?.paragraphStyle?.namedStyleType).toBe("NORMAL_TEXT");
    expect(bullets?.requests.at(-1)?.createParagraphBullets?.range).toEqual({ startIndex: 22, endIndex: 29 });
  });

  it("adds a timestamp prefix in the configured zone", async () => {
    const deps = makeDeps({ env: { TIMEZONE: "Asia/Kolkata" } });
    await call({ document: DOC_ID, text: "note", timestamp_prefix: true }, deps);
    expect(deps.docs.batches[0]?.requests[0]?.insertText?.text).toBe("\n2026-10-22T19:33:00+05:30 note");
  });

  it("uses the tab from the URL, and tab_id wins over it", async () => {
    const tabDoc = {
      documentId: DOC_ID,
      title: "Tabs",
      revisionId: "r",
      tabs: [
        { tabProperties: { tabId: "t.0" }, documentTab: { body: { content: docWithParagraphs(["a\n"]).body?.content } } },
        { tabProperties: { tabId: "t.x" }, documentTab: { body: { content: docWithParagraphs(["bbb\n"]).body?.content } } },
      ],
    };
    const deps = makeDeps({ docs: new FakeDocsApi(tabDoc) });
    const fromUrl = await call({ document: `${url}?tab=t.x`, text: "hi" }, deps);
    expect(fromUrl.structured).toMatchObject({ tab_id: "t.x", inserted_start_index: 4 });
    expect(fromUrl.structured.document_url).toBe(`${url}?tab=t.x`);
    expect(deps.docs.gets[0]?.includeTabsContent).toBe(true);
    const explicit = await call({ document: `${url}?tab=t.x`, text: "hi", tab_id: "t.0" }, deps);
    expect(explicit.structured).toMatchObject({ tab_id: "t.0", inserted_start_index: 2 });
  });

  it("dry_run writes nothing", async () => {
    const { deps, structured, text } = await call({ document: DOC_ID, text: "x", dry_run: true });
    expect(structured.status).toBe("dry_run");
    expect(deps.docs.batches).toHaveLength(0);
    expect(text).toContain("Nothing was written");
  });

  it("returns PERMISSION_DENIED with an actionable message for a doc the account cannot edit (§16.7)", async () => {
    const docs = new FakeDocsApi();
    docs.getError = mapGoogleError(googleError(403), { api: "docs", documentId: DOC_ID, accountEmail: "me@example.com" });
    const { result, structured } = await call({ document: DOC_ID, text: "x" }, makeDeps({ docs }));
    expect(result.isError).toBe(true);
    expect(structured.error).toEqual({
      code: "PERMISSION_DENIED",
      message: `The authenticated account cannot edit document ${DOC_ID}. Share it with me@example.com as an Editor, then retry.`,
      retryable: false,
    });
  });

  it("blocks documents outside ALLOWED_DOCUMENT_IDS before any API call", async () => {
    const deps = makeDeps({ env: { ALLOWED_DOCUMENT_IDS: "someOtherDocumentId1234567" } });
    const { structured } = await call({ document: DOC_ID, text: "x" }, deps);
    expect(structured.error.code).toBe("POLICY_BLOCKED");
    expect(deps.docs.gets).toHaveLength(0);
  });

  it.each([
    [{ document: "not a doc", text: "x" }, "document must be"],
    [{ document: DOC_ID, text: "\n\n" }, "visible character"],
    [{ document: DOC_ID, text: "x".repeat(200 * 1024 + 1) }, "text is"],
    [{ document: DOC_ID, text: "x", tab_id: "bad tab!" }, "tab_id"],
  ])("returns INVALID_ARGUMENT for %#", async (args, message) => {
    const { structured } = await call(args);
    expect(structured.error.code).toBe("INVALID_ARGUMENT");
    expect(structured.error.message).toContain(message);
  });

  it("rate-limits appends", async () => {
    const deps = makeDeps({ env: { RATE_LIMIT_DOC_APPENDS_PER_MINUTE: "1" } });
    await call({ document: DOC_ID, text: "1" }, deps);
    expect((await call({ document: DOC_ID, text: "2" }, deps)).structured.error.code).toBe("RATE_LIMITED");
  });
});
