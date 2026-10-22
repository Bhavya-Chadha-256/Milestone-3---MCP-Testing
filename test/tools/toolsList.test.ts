import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectClient, makeDeps } from "../helpers/fakes.js";

const FORBIDDEN_KEYWORDS = ["oneOf", "anyOf", "allOf", "$ref", "patternProperties", "$defs", "definitions"];

/** Walk a JSON Schema, collecting every keyword used and the nesting depth of objects. */
function walk(schema: unknown, visit: (key: string, value: unknown, objectDepth: number) => void, depth = 0) {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;
  const nextDepth = s.type === "object" ? depth + 1 : depth;
  for (const [k, v] of Object.entries(s)) {
    visit(k, v, nextDepth);
    if (k === "properties" && v && typeof v === "object") {
      for (const child of Object.values(v)) walk(child, visit, nextDepth);
    } else if (k === "items") {
      walk(v, visit, nextDepth);
    }
  }
}

describe("tools/list (§5, §16.2)", () => {
  let tools: Tool[];
  let close: () => Promise<unknown>;

  beforeAll(async () => {
    const conn = await connectClient(makeDeps());
    close = conn.close;
    tools = (await conn.client.listTools()).tools;
  });
  afterAll(() => close());

  it("returns exactly the three tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["gdocs_append_text", "gmail_send_email", "google_auth_status"]);
  });

  it("uses client-safe tool names", () => {
    for (const t of tools) expect(t.name).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it("every tool has a description, title, annotations and an output schema", () => {
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.annotations?.title).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
      expect(t.outputSchema?.type).toBe("object");
    }
  });

  it("declares the specified annotations", () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const sideEffect = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    expect(byName.gmail_send_email?.annotations).toMatchObject({ ...sideEffect, title: "Send Gmail email" });
    expect(byName.gdocs_append_text?.annotations).toMatchObject({ ...sideEffect, title: "Append to Google Doc" });
    expect(byName.google_auth_status?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("input and output schemas avoid keywords that function-calling implementations mishandle", () => {
    for (const t of tools) {
      for (const schema of [t.inputSchema, t.outputSchema]) {
        walk(schema, (key) => expect(FORBIDDEN_KEYWORDS, `${t.name} uses ${key}`).not.toContain(key));
      }
    }
  });

  it("input schemas are at most one level of nesting with a description on every property", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      walk(t.inputSchema, (key, value, depth) => {
        expect(depth, `${t.name} nests too deeply`).toBeLessThanOrEqual(2);
        if (key === "type") expect(["object", "array", "string", "boolean", "number", "integer"]).toContain(value);
      });
      for (const [name, prop] of Object.entries(t.inputSchema.properties ?? {})) {
        expect((prop as { description?: string }).description, `${t.name}.${name}`).toBeTruthy();
      }
    }
  });

  it("lists the required fields", () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.gmail_send_email?.inputSchema.required).toEqual(["to", "subject", "body"]);
    expect(byName.gdocs_append_text?.inputSchema.required).toEqual(["document", "text"]);
  });
});
