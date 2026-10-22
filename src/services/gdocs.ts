import { google, type docs_v1 } from "googleapis";
import type { AuthProvider } from "../auth/provider.js";
import { ToolError, googleRequestId, invalidArgument, mapGoogleError, withRetry, type RetryOptions } from "../errors.js";
import type { Logger } from "../logger.js";

export const PARAGRAPH_STYLES = ["NORMAL_TEXT", "HEADING_1", "HEADING_2", "HEADING_3", "TITLE", "SUBTITLE"] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

type Document = docs_v1.Schema$Document;
type StructuralElement = docs_v1.Schema$StructuralElement;
type Request = docs_v1.Schema$Request;

// ---------------------------------------------------------------------------
// Document ID parsing
// ---------------------------------------------------------------------------

export interface DocumentRef {
  documentId: string;
  /** Tab from a `?tab=t.xxx` URL parameter, if present. */
  tabId?: string;
}

const DOC_ID = /^[A-Za-z0-9_-]{20,128}$/;
const DOC_PATH = /^\/document\/(?:u\/\d+\/)?d\/([^/]+)(?:\/.*)?$/;

/** Accepts a raw document ID or a https://docs.google.com/document/d/<ID>/... URL (§8.2 step 1). */
export function parseDocumentReference(input: string): DocumentRef {
  const value = input.trim();
  if (DOC_ID.test(value)) return { documentId: value };

  const looksLikeUrl = /^(https?:\/\/)?docs\.google\.com\//i.test(value);
  if (!looksLikeUrl) {
    throw invalidArgument(
      "document must be a Google Docs document ID or a URL like https://docs.google.com/document/d/<ID>/edit.",
    );
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw invalidArgument("document is not a valid URL.");
  }
  if (url.hostname.toLowerCase() !== "docs.google.com") {
    throw invalidArgument("document URL must be on docs.google.com.");
  }
  if (/^\/document\/(?:u\/\d+\/)?d\/e\//.test(url.pathname)) {
    throw invalidArgument(
      'That is a "Publish to the web" link, which cannot be edited. Use the document\'s normal editing URL (…/document/d/<ID>/edit).',
    );
  }
  const match = DOC_PATH.exec(url.pathname);
  if (!match?.[1] || !DOC_ID.test(match[1])) {
    throw invalidArgument(
      "Could not find a document ID in that URL. Expected https://docs.google.com/document/d/<ID>/... (Sheets, Slides and Drive links are not supported).",
    );
  }
  const tab = url.searchParams.get("tab") ?? undefined;
  return tab ? { documentId: match[1], tabId: tab } : { documentId: match[1] };
}

export function documentUrl(documentId: string, tabId?: string): string {
  const base = `https://docs.google.com/document/d/${documentId}/edit`;
  return tabId ? `${base}?tab=${encodeURIComponent(tabId)}` : base;
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Characters the Docs API silently strips from inserted text. Removing them
 * up front keeps our computed indices exact.
 */
const STRIPPED_BY_DOCS = /[\u0000-\u0008\u000c-\u001f-]/g;

export function prepareAppendText(text: string, timestampPrefix?: string): string {
  let t = text.replace(/\r\n?/g, "\n").replace(STRIPPED_BY_DOCS, "");
  t = t.replace(/\n+$/, ""); // a trailing newline would only add an empty paragraph
  if (timestampPrefix && t) t = `${timestampPrefix} ${t}`;
  return t;
}

/** ISO-8601 with the zone's offset, e.g. 2026-10-22T14:03:00Z or 2026-10-22T19:33:00+05:30. */
export function formatTimestamp(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  // ICU prints "GMT", "GMT+00:00" or "GMT+05:30" depending on version and zone.
  const raw = (parts.timeZoneName ?? "GMT").replace("GMT", "");
  const offset = raw === "" || /^[+-]00:?00$/.test(raw) ? "Z" : raw;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// ---------------------------------------------------------------------------
// Insertion plan (pure; unit-tested without network)
// ---------------------------------------------------------------------------

interface TabLike {
  tabProperties?: { tabId?: string | null; title?: string | null } | null;
  documentTab?: { body?: { content?: StructuralElement[] | null } | null } | null;
  childTabs?: TabLike[] | null;
}

function flattenTabs(tabs: TabLike[] | null | undefined): TabLike[] {
  return (tabs ?? []).flatMap((t) => [t, ...flattenTabs(t.childTabs)]);
}

/** Body content of the requested tab (or the first tab), §8.2 step 3. */
export function findTabContent(doc: Document, tabId?: string): StructuralElement[] {
  if (!tabId) {
    const first = doc.body?.content ?? flattenTabs(doc.tabs)[0]?.documentTab?.body?.content;
    return first ?? [];
  }
  const all = flattenTabs(doc.tabs);
  const tab = all.find((t) => t.tabProperties?.tabId === tabId);
  if (!tab) {
    const available = all
      .map((t) => `${t.tabProperties?.tabId}${t.tabProperties?.title ? ` ("${t.tabProperties.title}")` : ""}`)
      .join(", ");
    throw new ToolError(
      "NOT_FOUND",
      `Tab ${tabId} was not found in document ${doc.documentId ?? ""}.${available ? ` Available tabs: ${available}.` : ""}`,
    );
  }
  return tab.documentTab?.body?.content ?? [];
}

export interface InsertionPoint {
  /** Index just before the body's final newline (last element's endIndex - 1). */
  index: number;
  /** True when the last paragraph is empty, so text can go straight into it. */
  endsWithEmptyParagraph: boolean;
  /** True when the last paragraph is a list item (new paragraphs would inherit the bullet). */
  lastParagraphIsBullet: boolean;
}

export function computeInsertionPoint(content: StructuralElement[]): InsertionPoint {
  const last = content[content.length - 1];
  if (!last || typeof last.endIndex !== "number") {
    return { index: 1, endsWithEmptyParagraph: true, lastParagraphIsBullet: false };
  }
  const paragraph = last.paragraph;
  const text = (paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
  const hasNonTextElement = (paragraph?.elements ?? []).some((e) => !e.textRun);
  return {
    index: Math.max(1, last.endIndex - 1),
    endsWithEmptyParagraph: Boolean(paragraph) && !hasNonTextElement && text.replace(/\n$/, "") === "",
    lastParagraphIsBullet: Boolean(paragraph?.bullet),
  };
}

export interface AppendOptions {
  text: string;
  paragraphStyle: ParagraphStyle;
  asBullets: boolean;
  addSeparator: boolean;
  tabId?: string;
}

export interface AppendPlan {
  insertedText: string;
  startIndex: number;
  endIndex: number;
  separatorAdded: boolean;
  requests: Request[];
}

/** Character styles that would otherwise leak from the preceding text (bold, links, ...). */
const RESET_TEXT_STYLE_FIELDS = "bold,italic,underline,strikethrough,smallCaps,baselineOffset,link,backgroundColor";

export function buildAppendPlan(content: StructuralElement[], opts: AppendOptions): AppendPlan {
  const point = computeInsertionPoint(content);
  const separatorAdded = opts.addSeparator && !point.endsWithEmptyParagraph;
  const insertedText = (separatorAdded ? "\n" : "") + opts.text;
  const startIndex = point.index;
  const endIndex = startIndex + insertedText.length;
  // The new paragraphs begin after the separator; never restyle the existing last paragraph.
  const newParagraphsStart = separatorAdded ? startIndex + 1 : startIndex;
  const tab = opts.tabId ? { tabId: opts.tabId } : {};
  const range = { startIndex: newParagraphsStart, endIndex, ...tab };

  // Split paragraphs inherit the previous one's style, bullet and character formatting.
  const removeBullet = !opts.asBullets && point.lastParagraphIsBullet;
  const requests: Request[] = [{ insertText: { location: { index: startIndex, ...tab }, text: insertedText } }];
  // Docs turns a removed bullet's nesting into start indentation, so reset that too.
  if (removeBullet) requests.push({ deleteParagraphBullets: { range } });
  requests.push(
    {
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: opts.paragraphStyle },
        fields: removeBullet ? "namedStyleType,indentStart,indentFirstLine" : "namedStyleType",
      },
    },
    { updateTextStyle: { range, textStyle: {}, fields: RESET_TEXT_STYLE_FIELDS } },
  );
  if (opts.asBullets) {
    requests.push({ createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
  }
  return { insertedText, startIndex, endIndex, separatorAdded, requests };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** What the append logic needs from the Docs API; mocked in tests. */
export interface DocsApi {
  getDocument(documentId: string, includeTabsContent: boolean): Promise<Document>;
  batchUpdate(documentId: string, requests: Request[], requiredRevisionId?: string): Promise<{ requestId?: string }>;
}

export interface AppendResult {
  status: "appended" | "dry_run";
  documentId: string;
  title: string;
  tabId?: string;
  startIndex: number;
  endIndex: number;
  charactersAppended: number;
  separatorAdded: boolean;
  requestId?: string;
}

export async function appendToDocument(
  api: DocsApi,
  ref: DocumentRef,
  opts: AppendOptions,
  { dryRun }: { dryRun: boolean },
): Promise<AppendResult> {
  const tabId = opts.tabId ?? ref.tabId;
  const options = { ...opts, tabId };
  for (let attempt = 1; ; attempt++) {
    const doc = await api.getDocument(ref.documentId, Boolean(tabId));
    const plan = buildAppendPlan(findTabContent(doc, tabId), options);
    const result: AppendResult = {
      status: dryRun ? "dry_run" : "appended",
      documentId: ref.documentId,
      title: doc.title ?? "",
      ...(tabId ? { tabId } : {}),
      startIndex: plan.startIndex,
      endIndex: plan.endIndex,
      charactersAppended: plan.insertedText.length,
      separatorAdded: plan.separatorAdded,
    };
    if (dryRun) return result;
    try {
      const { requestId } = await api.batchUpdate(ref.documentId, plan.requests, doc.revisionId ?? undefined);
      return { ...result, requestId };
    } catch (err) {
      // §8.2 step 5: on a revision conflict, re-fetch and retry once.
      if (err instanceof ToolError && err.code === "CONFLICT" && attempt === 1) continue;
      if (err instanceof ToolError && err.code === "CONFLICT") {
        throw new ToolError(
          "CONFLICT",
          `Document ${ref.documentId} kept changing while appending (another edit happened twice in a row). Nothing was written; retry in a moment.`,
        );
      }
      throw err;
    }
  }
}

/** Google-backed DocsApi with retries and error mapping. */
export class GoogleDocsService implements DocsApi {
  constructor(
    private readonly auth: AuthProvider,
    private readonly logger: Logger,
    private readonly retry: RetryOptions = {},
  ) {}

  async getDocument(documentId: string, includeTabsContent: boolean): Promise<Document> {
    const docs = await this.client();
    try {
      const res = await withRetry(() => docs.documents.get({ documentId, includeTabsContent }), this.retry);
      return res.data;
    } catch (err) {
      throw await this.mapError(err, documentId);
    }
  }

  async batchUpdate(documentId: string, requests: Request[], requiredRevisionId?: string) {
    const docs = await this.client();
    try {
      const res = await withRetry(
        () =>
          docs.documents.batchUpdate({
            documentId,
            requestBody: { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) },
          }),
        { ...this.retry, allowAmbiguousNetwork: false },
      );
      return { requestId: googleRequestId(res.headers) };
    } catch (err) {
      throw await this.mapError(err, documentId);
    }
  }

  private async client() {
    return google.docs({ version: "v1", auth: await this.auth.getClient("docs"), retry: false });
  }

  private async mapError(err: unknown, documentId: string) {
    const mapped = mapGoogleError(err, { api: "docs", documentId, accountEmail: await this.auth.getUserEmail() });
    if (mapped.code === "AUTH_REQUIRED") this.auth.invalidate();
    this.logger.debug("docs request failed", { error_code: mapped.code, document_id: documentId });
    return mapped;
  }
}
