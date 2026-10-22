import { describe, expect, it } from "vitest";
import type { docs_v1 } from "googleapis";
import { ToolError } from "../../src/errors.js";
import {
  appendToDocument,
  buildAppendPlan,
  computeInsertionPoint,
  findTabContent,
  formatTimestamp,
  prepareAppendText,
  type AppendOptions,
} from "../../src/services/gdocs.js";
import { DOC_ID, FakeDocsApi, bodyContent, docWithParagraphs } from "../helpers/fakes.js";

type Plan = ReturnType<typeof buildAppendPlan>;
const paragraphStyle = (plan: Plan) => plan.requests.find((r) => r.updateParagraphStyle)?.updateParagraphStyle;
const textStyle = (plan: Plan) => plan.requests.find((r) => r.updateTextStyle)?.updateTextStyle;

const opts = (o: Partial<AppendOptions> = {}): AppendOptions => ({
  text: "New entry",
  paragraphStyle: "NORMAL_TEXT",
  asBullets: false,
  addSeparator: true,
  ...o,
});

describe("computeInsertionPoint", () => {
  it("empty doc: inserts at index 1 into the empty paragraph", () => {
    expect(computeInsertionPoint(bodyContent(["\n"]))).toEqual({
      index: 1,
      endsWithEmptyParagraph: true,
      lastParagraphIsBullet: false,
    });
  });

  it("uses the last element's endIndex - 1", () => {
    // "Hello\n" occupies 1..7, so the final newline is at 6.
    expect(computeInsertionPoint(bodyContent(["Hello\n"])).index).toBe(6);
    expect(computeInsertionPoint(bodyContent(["Hello\n", "World\n"])).index).toBe(12);
  });

  it("doc ending in a list: flags the bullet", () => {
    const point = computeInsertionPoint(bodyContent(["Intro\n", { text: "item\n", bullet: true }]));
    expect(point).toEqual({ index: 11, endsWithEmptyParagraph: false, lastParagraphIsBullet: true });
  });

  it("treats a paragraph with only a newline as empty, and one with an inline object as not empty", () => {
    expect(computeInsertionPoint(bodyContent(["Text\n", "\n"])).endsWithEmptyParagraph).toBe(true);
    const content = bodyContent(["\n"]);
    content[1]!.paragraph!.elements!.unshift({ inlineObjectElement: { inlineObjectId: "img" } });
    expect(computeInsertionPoint(content).endsWithEmptyParagraph).toBe(false);
  });
});

describe("findTabContent (multi-tab docs)", () => {
  const multiTab: docs_v1.Schema$Document = {
    documentId: DOC_ID,
    tabs: [
      { tabProperties: { tabId: "t.0", title: "Main" }, documentTab: { body: { content: bodyContent(["Main tab\n"]) } } },
      {
        tabProperties: { tabId: "t.1", title: "Notes" },
        documentTab: { body: { content: bodyContent(["Notes tab text\n"]) } },
        childTabs: [
          { tabProperties: { tabId: "t.2", title: "Child" }, documentTab: { body: { content: bodyContent(["c\n"]) } } },
        ],
      },
    ],
  };

  it("picks the requested tab, including nested child tabs", () => {
    expect(computeInsertionPoint(findTabContent(multiTab, "t.1")).index).toBe(15);
    expect(computeInsertionPoint(findTabContent(multiTab, "t.2")).index).toBe(2);
  });

  it("defaults to the first tab", () => {
    expect(computeInsertionPoint(findTabContent(multiTab)).index).toBe(9);
    expect(computeInsertionPoint(findTabContent(docWithParagraphs(["abc\n"]))).index).toBe(4);
  });

  it("reports unknown tabs as NOT_FOUND, listing the available ones", () => {
    try {
      findTabContent(multiTab, "t.9");
      expect.fail("expected an error");
    } catch (err) {
      expect((err as ToolError).code).toBe("NOT_FOUND");
      expect((err as ToolError).message).toContain('t.1 ("Notes")');
    }
  });
});

describe("buildAppendPlan", () => {
  it("adds a separator so text never merges into the last line", () => {
    const plan = buildAppendPlan(bodyContent(["Hello\n"]), opts());
    expect(plan.separatorAdded).toBe(true);
    expect(plan.insertedText).toBe("\nNew entry");
    expect(plan).toMatchObject({ startIndex: 6, endIndex: 16 });
    expect(plan.requests[0]).toEqual({ insertText: { location: { index: 6 }, text: "\nNew entry" } });
    // Styles start after the separator so the existing paragraph is untouched.
    expect(paragraphStyle(plan)?.range).toEqual({ startIndex: 7, endIndex: 16 });
  });

  it("writes straight into a trailing empty paragraph", () => {
    const plan = buildAppendPlan(bodyContent(["Hello\n", "\n"]), opts());
    expect(plan.separatorAdded).toBe(false);
    expect(plan).toMatchObject({ startIndex: 7, endIndex: 16, insertedText: "New entry" });
  });

  it("honours add_separator=false", () => {
    const plan = buildAppendPlan(bodyContent(["Hello\n"]), opts({ addSeparator: false }));
    expect(plan.insertedText).toBe("New entry");
    expect(paragraphStyle(plan)?.range?.startIndex).toBe(6);
  });

  it("applies heading styles and always resets inherited styles", () => {
    const plan = buildAppendPlan(bodyContent(["Hello\n"]), opts({ paragraphStyle: "HEADING_2" }));
    expect(paragraphStyle(plan)).toMatchObject({
      paragraphStyle: { namedStyleType: "HEADING_2" },
      fields: "namedStyleType",
    });
    expect(textStyle(plan)?.fields).toContain("link");
    const normal = buildAppendPlan(bodyContent(["# Big heading\n"]), opts());
    expect(paragraphStyle(normal)?.paragraphStyle?.namedStyleType).toBe("NORMAL_TEXT");
  });

  it("creates bullets for each appended paragraph", () => {
    const plan = buildAppendPlan(bodyContent(["Hello\n"]), opts({ text: "one\ntwo", asBullets: true }));
    expect(plan.requests.at(-1)).toEqual({
      createParagraphBullets: { range: { startIndex: 7, endIndex: 14 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
    });
  });

  it("doc ending in a list: removes the inherited bullet and its indentation from plain text", () => {
    const plan = buildAppendPlan(bodyContent([{ text: "item\n", bullet: true }]), opts());
    expect(plan.requests.map((r) => Object.keys(r)[0])).toEqual([
      "insertText",
      "deleteParagraphBullets",
      "updateParagraphStyle",
      "updateTextStyle",
    ]);
    expect(plan.requests[1]).toEqual({ deleteParagraphBullets: { range: { startIndex: 6, endIndex: 15 } } });
    expect(paragraphStyle(plan)?.fields).toBe("namedStyleType,indentStart,indentFirstLine");
  });

  it("leaves indentation alone when no bullet is removed", () => {
    expect(paragraphStyle(buildAppendPlan(bodyContent(["x\n"]), opts()))?.fields).toBe("namedStyleType");
    const bulletsAfterList = buildAppendPlan(bodyContent([{ text: "item\n", bullet: true }]), opts({ asBullets: true }));
    expect(bulletsAfterList.requests.some((r) => r.deleteParagraphBullets)).toBe(false);
  });

  it("targets the tab in every request", () => {
    const plan = buildAppendPlan(bodyContent(["x\n"]), opts({ tabId: "t.1" }));
    expect(plan.requests[0]?.insertText?.location).toEqual({ index: 2, tabId: "t.1" });
    expect(paragraphStyle(plan)?.range?.tabId).toBe("t.1");
  });

  it("counts indices in UTF-16 code units, like the Docs API", () => {
    const plan = buildAppendPlan(bodyContent(["\n"]), opts({ text: "👋 hi" }));
    expect(plan.endIndex - plan.startIndex).toBe(5);
  });
});

describe("appendToDocument", () => {
  it("sends one batchUpdate with requiredRevisionId", async () => {
    const api = new FakeDocsApi();
    const result = await appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: false });
    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]?.revision).toBe("rev-1");
    expect(result).toMatchObject({ status: "appended", title: "Project Log", startIndex: 14, charactersAppended: 10 });
  });

  it("fetches tab content only when a tab is requested", async () => {
    const api = new FakeDocsApi();
    await appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: true });
    expect(api.gets[0]?.includeTabsContent).toBe(false);
  });

  it("dry run computes the insertion point without writing", async () => {
    const api = new FakeDocsApi();
    const result = await appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: true });
    expect(result.status).toBe("dry_run");
    expect(api.batches).toHaveLength(0);
  });

  it("re-fetches and retries once on a revision conflict", async () => {
    const api = new FakeDocsApi();
    api.batchErrors = [new ToolError("CONFLICT", "changed")];
    const result = await appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: false });
    expect(result.status).toBe("appended");
    expect(api.gets).toHaveLength(2);
    expect(api.batches).toHaveLength(1);
  });

  it("surfaces CONFLICT when the conflict persists after one retry", async () => {
    const api = new FakeDocsApi();
    api.batchErrors = [new ToolError("CONFLICT", "changed"), new ToolError("CONFLICT", "changed")];
    await expect(appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: false })).rejects.toMatchObject({
      code: "CONFLICT",
      retryable: true,
    });
    expect(api.gets).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const api = new FakeDocsApi();
    api.batchErrors = [new ToolError("PERMISSION_DENIED", "no")];
    await expect(appendToDocument(api, { documentId: DOC_ID }, opts(), { dryRun: false })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(api.gets).toHaveLength(1);
  });
});

describe("text preparation", () => {
  it("normalizes newlines, strips trailing newlines and characters Docs would drop", () => {
    expect(prepareAppendText("a\r\nb\rc\n\n")).toBe("a\nb\nc");
    expect(prepareAppendText("x\u0001yz\tw")).toBe("xyz\tw");
  });

  it("adds the timestamp prefix", () => {
    expect(prepareAppendText("note", "2026-10-22T14:03:00Z")).toBe("2026-10-22T14:03:00Z note");
  });

  it("formats ISO-8601 timestamps in the configured zone", () => {
    const d = new Date("2026-10-22T14:03:00Z");
    expect(formatTimestamp(d, "UTC")).toBe("2026-10-22T14:03:00Z");
    expect(formatTimestamp(d, "Asia/Kolkata")).toBe("2026-10-22T19:33:00+05:30");
    expect(formatTimestamp(d, "America/New_York")).toBe("2026-10-22T10:03:00-04:00");
  });
});
