import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invalidArgument } from "../errors.js";
import {
  PARAGRAPH_STYLES,
  appendToDocument,
  documentUrl,
  formatTimestamp,
  parseDocumentReference,
  prepareAppendText,
  type AppendResult,
} from "../services/gdocs.js";
import { runTool, successResult, type ToolDeps } from "./common.js";
import { validateMaxBytes } from "./validation.js";

export const GDOCS_APPEND_TEXT = "gdocs_append_text";

const MAX_TEXT_BYTES = 200 * 1024;
const TAB_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const gdocsAppendTextInput = {
  document: z
    .string()
    .describe("Document ID, or a full URL like https://docs.google.com/document/d/<ID>/edit. The ID is extracted automatically."),
  text: z.string().describe("Text to append, up to 200 KB. Each line becomes its own paragraph."),
  paragraph_style: z
    .enum(PARAGRAPH_STYLES)
    .default("NORMAL_TEXT")
    .describe("Paragraph style applied to all appended paragraphs. Default NORMAL_TEXT."),
  as_bullets: z.boolean().default(false).describe("Format each appended paragraph as a bulleted list item."),
  add_separator: z
    .boolean()
    .default(true)
    .describe("Start on a new paragraph if the document does not already end with an empty one, so text never merges into the last line. Default true."),
  timestamp_prefix: z
    .boolean()
    .default(false)
    .describe("Prefix the text with an ISO-8601 timestamp in the server's time zone."),
  tab_id: z
    .string()
    .optional()
    .describe("For multi-tab documents, the tab ID (e.g. \"t.0\") to append to. Defaults to the tab in the URL, else the first tab."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("When true, resolve the document and compute where the text would go, but do NOT write."),
};

export const gdocsAppendTextOutput = {
  status: z.enum(["appended", "dry_run"]),
  document_id: z.string(),
  title: z.string(),
  document_url: z.string(),
  tab_id: z.string().optional(),
  inserted_start_index: z.number().int().describe("Start index of the inserted text (UTF-16 code units)."),
  inserted_end_index: z.number().int().describe("End index (exclusive) of the inserted text."),
  characters_appended: z.number().int().describe("Characters inserted, including any separator newline."),
  separator_added: z.boolean().describe("Whether a newline was inserted first to start a new paragraph."),
};

type Input = z.infer<z.ZodObject<typeof gdocsAppendTextInput>>;

export async function handleGdocsAppendText(deps: ToolDeps, args: Input) {
  return runTool(GDOCS_APPEND_TEXT, deps.logger, async (log) => {
    const ref = parseDocumentReference(args.document);
    const dryRun = args.dry_run ?? false;
    log.document_id = ref.documentId;
    log.dry_run = dryRun;

    const tabId = args.tab_id?.trim() || undefined;
    if (tabId && !TAB_ID.test(tabId)) throw invalidArgument(`tab_id "${tabId}" is not a valid tab ID (e.g. "t.0").`);
    validateMaxBytes("text", args.text, MAX_TEXT_BYTES);
    const timestamp = args.timestamp_prefix
      ? formatTimestamp(deps.now?.() ?? new Date(), deps.config.timezone)
      : undefined;
    const text = prepareAppendText(args.text, timestamp);
    if (!text.trim()) throw invalidArgument("text must contain at least one visible character.");

    deps.policy.checkDocument(ref.documentId);
    if (!dryRun) deps.policy.acquireDocAppend();

    const result = await appendToDocument(
      deps.docs,
      ref,
      {
        text,
        paragraphStyle: args.paragraph_style ?? "NORMAL_TEXT",
        asBullets: args.as_bullets ?? false,
        addSeparator: args.add_separator ?? true,
        tabId,
      },
      { dryRun },
    );
    return { result: formatResult(result), googleRequestId: result.requestId };
  });
}

function formatResult(result: AppendResult) {
  const url = documentUrl(result.documentId, result.tabId);
  const structured = {
    status: result.status,
    document_id: result.documentId,
    title: result.title,
    document_url: url,
    ...(result.tabId ? { tab_id: result.tabId } : {}),
    inserted_start_index: result.startIndex,
    inserted_end_index: result.endIndex,
    characters_appended: result.charactersAppended,
    separator_added: result.separatorAdded,
  };
  const name = result.title ? `"${result.title}"` : `document ${result.documentId}`;
  const text =
    result.status === "dry_run"
      ? `Dry run: would append ${result.charactersAppended} characters to ${name} at index ${result.startIndex}. Nothing was written. ${url}`
      : `Appended ${result.charactersAppended} characters to ${name} (indexes ${result.startIndex}-${result.endIndex}). ${url}`;
  return successResult(text, structured);
}

export function registerGdocsAppendText(server: McpServer, deps: ToolDeps) {
  server.registerTool(
    GDOCS_APPEND_TEXT,
    {
      title: "Append to Google Doc",
      description:
        "Append text to the end of an existing Google Doc. Accepts a document ID or full Google Docs URL. Can optionally format the appended text as a heading or bullet list.",
      inputSchema: gdocsAppendTextInput,
      outputSchema: gdocsAppendTextOutput,
      annotations: {
        title: "Append to Google Doc",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => handleGdocsAppendText(deps, args),
  );
}
