import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleTools,
  findSearchMatches,
  findSectionLines,
  PROVIDER_DIAGNOSTICS_HEADINGS,
  parseViewerCommandMode,
  redactHeaders,
  renderProviderDiagnostics,
  renderProviderNeutralContent,
  renderStructured,
  SYSTEM_SECTION_HEADINGS,
  serializeProviderPayload,
  toProviderNeutralTool,
  type ProviderNeutralToolInput,
} from "../lib/footprint-model.ts";

test("Provider Request rendering keeps multiline values on real lines", () => {
  const display = renderStructured({
    system: "first paragraph\n\nsecond paragraph",
    messages: [{ role: "user", content: "message line one\nmessage line two" }],
  });

  const lines = display.split("\n").map((line) => line.trim());
  assert.ok(lines.includes("first paragraph"));
  assert.ok(lines.includes("second paragraph"));
  assert.ok(lines.includes("message line one"));
  assert.ok(lines.includes("message line two"));
  assert.ok(
    lines.indexOf("first paragraph") < lines.indexOf("second paragraph"),
  );
  assert.equal(display.includes("\\n"), false);
});

test("System Footprint has only prompt and tools with real prompt newlines", () => {
  const display = renderProviderNeutralContent({
    systemPrompt: "system line one\nsystem line two",
    tools: [
      {
        name: "search",
        description: "description line one\ndescription line two",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ],
  });

  const lines = display.split("\n").map((line) => line.trim());
  assert.ok(lines.includes("system line one"));
  assert.ok(lines.includes("system line two"));
  assert.ok(lines.includes("description line one"));
  assert.ok(lines.includes("description line two"));
  assert.ok(
    lines.indexOf("system line one") < lines.indexOf("system line two"),
  );
  assert.equal(display.includes("\\n"), false);
  assert.equal(display.includes("Messages"), false);
  for (const field of [
    "representation",
    "fidelity",
    "capture",
    "capturedAt",
    "runId",
    "contextSequence",
    "unavailable",
    "sourceInfo",
    "promptGuidelines",
  ]) {
    assert.equal(display.includes(field), false, `unexpected field: ${field}`);
  }
});

test("tool projection excludes ToolInfo internals and preserves schemas", () => {
  const parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "search text" },
    },
    required: ["query"],
    additionalProperties: false,
  };
  const descriptor = toProviderNeutralTool({
    name: "search",
    description: "Search files",
    parameters,
    sourceInfo: { source: "extension" },
    promptGuidelines: ["Use search for files"],
  } as ProviderNeutralToolInput & {
    sourceInfo: unknown;
    promptGuidelines: string[];
  });

  assert.deepEqual(descriptor, {
    name: "search",
    description: "Search files",
    parameters,
  });
  assert.equal(JSON.stringify(descriptor).includes("sourceInfo"), false);
  assert.equal(JSON.stringify(descriptor).includes("promptGuidelines"), false);
});

test("tool projection preserves constrainedSampling when present", () => {
  const descriptor = toProviderNeutralTool({
    name: "structured",
    description: "Structured tool",
    parameters: { type: "object" },
    constrainedSampling: { strict: true },
  });

  assert.deepEqual(descriptor, {
    name: "structured",
    description: "Structured tool",
    parameters: { type: "object" },
    constrainedSampling: { strict: true },
  });
});

test("display and provider JSON copy preserve duplicate actual content", () => {
  const payload = {
    system: "repeat\nrepeat",
    messages: [
      { role: "user", content: "repeat" },
      { role: "user", content: "repeat" },
    ],
  };
  const display = renderStructured(payload);
  const copy = serializeProviderPayload(payload);

  assert.equal((display.match(/repeat/g) ?? []).length, 4);
  assert.deepEqual(JSON.parse(copy), payload);
  assert.equal((copy.match(/repeat/g) ?? []).length, 4);
});

test("renderStructured handles circular references while keeping shared non-cyclic values", () => {
  const shared = { id: "shared" };
  const cyclic: Record<string, unknown> = { first: shared, second: shared };
  cyclic.self = cyclic;

  const display = renderStructured(cyclic);
  assert.equal((display.match(/"shared"/g) ?? []).length, 2);
  assert.ok(display.includes('"[Circular]"'));
});

test("filterVisibleTools excludes hidden loadout declarations in order", () => {
  const tools = [
    { name: "read" },
    { name: "bash" },
    { name: "codemode" },
    { name: "edit" },
  ];
  assert.deepEqual(filterVisibleTools(tools, ["read", "edit"]), [
    { name: "bash" },
    { name: "codemode" },
  ]);
  assert.deepEqual(filterVisibleTools(tools, undefined), tools);
});

test("redactHeaders redacts sensitive headers, drops null entries, and preserves safe metadata", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer sk-secret",
    "x-api-key": "ant-key-123",
    "X-Goog-Api-Key": "goog-key",
    Cookie: "sid=abc",
    "Set-Cookie": "sid=def",
    "x-custom-secret": "shh",
    "x-auth-token": "tok",
    "x-dropped": null,
    "x-session-id": "sess-42",
    "x-request-id": "req-99",
    "anthropic-beta": "prompt-caching-2024-07-31",
    "content-type": "application/json",
    "retry-after": "3",
  });

  assert.deepEqual(redacted, {
    Authorization: "[REDACTED]",
    "x-api-key": "[REDACTED]",
    "X-Goog-Api-Key": "[REDACTED]",
    Cookie: "[REDACTED]",
    "Set-Cookie": "[REDACTED]",
    "x-custom-secret": "[REDACTED]",
    "x-auth-token": "[REDACTED]",
    "x-session-id": "sess-42",
    "x-request-id": "req-99",
    "anthropic-beta": "prompt-caching-2024-07-31",
    "content-type": "application/json",
    "retry-after": "3",
  });
});

test("renderProviderDiagnostics includes headers, response status, and payload sections", () => {
  const rendered = renderProviderDiagnostics({
    requestHeaders: {
      authorization: "[REDACTED]",
      "x-session-id": "sess-1",
    },
    response: {
      status: 200,
      headers: { "x-request-id": "req-1" },
      responseCount: 1,
    },
    payloadDisplay: '{\n  "model": "claude"\n}',
  });

  const lines = rendered.split("\n");
  const sections = findSectionLines(lines, PROVIDER_DIAGNOSTICS_HEADINGS);
  assert.equal(sections.length, 3);
  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(rendered.includes('"status": 200'));
  assert.ok(rendered.includes('"model": "claude"'));
});

test("findSearchMatches finds case-insensitive matches across lines", () => {
  const matches = findSearchMatches(
    ["Hello world", "WORLD of world", "nothing"],
    "world",
  );
  assert.deepEqual(matches, [
    { lineIndex: 0, start: 6, end: 11 },
    { lineIndex: 1, start: 0, end: 5 },
    { lineIndex: 1, start: 9, end: 14 },
  ]);
  assert.deepEqual(findSearchMatches(["abc"], "   "), []);
});

test("findSectionLines locates only headings followed by matching horizontal rules", () => {
  const rendered = renderProviderNeutralContent({
    systemPrompt: "Tools\nnot a heading because no rule",
    tools: [],
  });
  const lines = rendered.split("\n");
  const indices = findSectionLines(lines, SYSTEM_SECTION_HEADINGS);
  assert.equal(indices.length, 2);
  assert.equal(lines[indices[0]!], "System Prompt");
  assert.equal(lines[indices[1]!], "Tools");
});

test("parseViewerCommandMode parses empty, system, provider, and rejects unknown args", () => {
  assert.equal(parseViewerCommandMode(""), "system");
  assert.equal(parseViewerCommandMode("   "), "system");
  assert.equal(parseViewerCommandMode("system"), "system");
  assert.equal(parseViewerCommandMode("SYSTEM"), "system");
  assert.equal(parseViewerCommandMode("provider"), "provider");
  assert.equal(parseViewerCommandMode("  Provider "), "provider");
  assert.equal(parseViewerCommandMode("other"), undefined);
});
