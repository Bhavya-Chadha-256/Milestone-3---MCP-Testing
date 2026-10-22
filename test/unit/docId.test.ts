import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors.js";
import { documentUrl, parseDocumentReference } from "../../src/services/gdocs.js";
import { DOC_ID } from "../helpers/fakes.js";

describe("parseDocumentReference", () => {
  it("accepts a raw document ID", () => {
    expect(parseDocumentReference(DOC_ID)).toEqual({ documentId: DOC_ID });
    expect(parseDocumentReference(`  ${DOC_ID}\n`)).toEqual({ documentId: DOC_ID });
  });

  it.each([
    `https://docs.google.com/document/d/${DOC_ID}/edit`,
    `https://docs.google.com/document/d/${DOC_ID}`,
    `https://docs.google.com/document/d/${DOC_ID}/`,
    `https://docs.google.com/document/d/${DOC_ID}/edit#heading=h.abc`,
    `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
    `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
    `docs.google.com/document/d/${DOC_ID}/edit`,
  ])("extracts the ID from %s", (url) => {
    expect(parseDocumentReference(url).documentId).toBe(DOC_ID);
  });

  it("extracts the tab from /edit?tab=... URLs", () => {
    expect(parseDocumentReference(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.abc123`)).toEqual({
      documentId: DOC_ID,
      tabId: "t.abc123",
    });
  });

  it.each([
    ["empty", ""],
    ["a word", "notes"],
    ["a short ID", "abc123"],
    ["a Sheets URL", `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`],
    ["another host", `https://evil.example.com/document/d/${DOC_ID}/edit`],
    ["a lookalike host", `https://docs.google.com.evil.com/document/d/${DOC_ID}/edit`],
    ["a publish-to-web link", "https://docs.google.com/document/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pub"],
    ["an ID with bad characters", `${DOC_ID.slice(0, 30)}!@#$`],
    ["a URL without an ID", "https://docs.google.com/document/"],
  ])("rejects %s with INVALID_ARGUMENT", (_label, input) => {
    try {
      parseDocumentReference(input);
      expect.fail("expected an error");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("INVALID_ARGUMENT");
    }
  });

  it("builds edit URLs", () => {
    expect(documentUrl(DOC_ID)).toBe(`https://docs.google.com/document/d/${DOC_ID}/edit`);
    expect(documentUrl(DOC_ID, "t.0")).toBe(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`);
  });
});
