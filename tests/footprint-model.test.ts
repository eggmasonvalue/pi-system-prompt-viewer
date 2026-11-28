import assert from "node:assert/strict";
import test from "node:test";
import {
  ARRAY_COLLAPSED,
  analyzeSystemPrompt,
  buildStructuredTree,
  collectMatchingFoldPaths,
  collectSmartCollapsedPaths,
  filterVisibleTools,
  findSearchMatches,
  findSectionLines,
  MULTILINE_COLLAPSED,
  OBJECT_COLLAPSED,
  PROVIDER_DIAGNOSTICS_HEADINGS,
  parseViewerCommandMode,
  redactHeaders,
  renderProviderDiagnostics,
  renderProviderNeutralContent,
  renderStructured,
  renderStructuredTree,
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

test("analyzeSystemPrompt extracts top-level XML blocks while skipping nested tags, fences, and unclosed tags", () => {
  const prompt = [
    "You are a coding assistant.",
    "",
    "<tools>",
    "- read: Read file contents",
    "</tools>",
    "",
    "<unclosed_placeholder>",
    "Still top-level prose.",
    "",
    "<project_context>",
    "<project_instructions path=\"AGENTS.md\">",
    "# Nested Heading Inside XML",
    "```xml",
    "</project_context>",
    "<fake_section>",
    "</fake_section>",
    "```",
    "</project_instructions>",
    "</project_context>",
    "",
    "<skills>",
    "  <available_skills>",
    "    <skill><name>demo</name></skill>",
    "  </available_skills>",
    "</skills>",
    "",
    "<cwd>/workspace/demo</cwd>",
  ].join("\n");

  const analysis = analyzeSystemPrompt(prompt);
  assert.deepEqual(
    analysis.landmarks.map((item) => item.label),
    ["<tools>", "<project_context>", "<skills>", "<cwd>"],
  );
  assert.equal(analysis.taggedLines.get(2), "xml-open");
  assert.equal(analysis.taggedLines.get(4), "xml-close");
  assert.equal(analysis.taggedLines.get(26), "xml-inline");
});

test("analyzeSystemPrompt supports top-level Markdown headings outside XML and code fences", () => {
  const prompt = [
    "# Role",
    "General instructions.",
    "```md",
    "## Fenced Heading",
    "```",
    "## Constraints",
    "Be concise.",
  ].join("\n");

  const analysis = analyzeSystemPrompt(prompt);
  assert.deepEqual(
    analysis.landmarks.map((item) => item.label),
    ["# Role", "## Constraints"],
  );
});

test("smart-collapsed structured rendering uses pure delimiters with zero fabricated preview text", () => {
  const longOutput = Array.from(
    { length: 12 },
    (_, i) => `output line ${i + 1}`,
  ).join("\n");
  const payload = {
    model: "claude-sonnet-4",
    max_tokens: 8192,
    emptyObj: {},
    emptyArr: [],
    thinking: { type: "enabled", budget_tokens: 2048 },
    system: "system line one\nsystem line two",
    messages: [
      { role: "user", content: "short line 1\nshort line 2" },
      { role: "tool", content: longOutput },
    ],
    tools: [
      {
        name: "secretToolName",
        description: "secret tool description",
        input_schema: { type: "object" },
      },
    ],
    stream: true,
  };

  const tree = buildStructuredTree(payload);
  const smartCollapsed = collectSmartCollapsedPaths(tree);
  const initialLines = renderStructuredTree(tree, smartCollapsed);
  const initialText = initialLines.map((line) => line.text).join("\n");

  // Top-level scalars and empty containers stay verbatim; foldable sections use pure delimiters.
  assert.ok(initialText.includes('"model": "claude-sonnet-4",'));
  assert.ok(initialText.includes('"emptyObj": {},'));
  assert.ok(initialText.includes('"emptyArr": [],'));
  assert.ok(initialText.includes(`"thinking": ${OBJECT_COLLAPSED},`));
  assert.ok(initialText.includes(`"system": ${MULTILINE_COLLAPSED},`));
  assert.ok(initialText.includes(`"messages": ${ARRAY_COLLAPSED},`));
  assert.ok(initialText.includes(`"tools": ${ARRAY_COLLAPSED},`));

  // Zero inner payload values or synthesized previews appear while collapsed.
  for (const hidden of [
    "budget_tokens",
    "system line one",
    "short line 1",
    "output line 1",
    "secretToolName",
    "secret tool description",
  ]) {
    assert.equal(initialText.includes(hidden), false, `leaked: ${hidden}`);
  }

  // Top-level foldable keys are marked as section targets.
  const sectionKeys = initialLines
    .filter((line) => line.topLevelKey !== undefined)
    .map((line) => line.topLevelKey);
  assert.deepEqual(sectionKeys, ["thinking", "system", "messages", "tools"]);

  // Expanding `messages` reveals collapsed item shells `{ … }` without dumping inner lines.
  const afterMessagesOpen = new Set(smartCollapsed);
  afterMessagesOpen.delete('$."messages"');
  const messagesLines = renderStructuredTree(tree, afterMessagesOpen)
    .map((line) => line.text)
    .join("\n");
  assert.ok(messagesLines.includes(`    ${OBJECT_COLLAPSED},`));
  assert.equal(messagesLines.includes("short line 1"), false);

  // Expanding the second message shows its role while keeping the 12-line output folded.
  afterMessagesOpen.delete('$."messages"[1]');
  const messageTwoText = renderStructuredTree(tree, afterMessagesOpen)
    .map((line) => line.text)
    .join("\n");
  assert.ok(messageTwoText.includes('"role": "tool",'));
  assert.ok(messageTwoText.includes(`"content": ${MULTILINE_COLLAPSED}`));
  assert.equal(messageTwoText.includes("output line 1"), false);

  // Expanding everything matches `renderStructured(payload)` byte-for-byte.
  const fullyExpanded = renderStructuredTree(tree, new Set())
    .map((line) => line.text)
    .join("\n");
  assert.equal(fullyExpanded, renderStructured(payload));
});

test("collectMatchingFoldPaths reveals only ancestor branches containing search matches", () => {
  const tree = buildStructuredTree({
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [
      { role: "user", content: "unrelated turn" },
      { role: "assistant", content: "contains needle_token here\non line two" },
    ],
    tools: [{ name: "read", description: "read files" }],
  });

  const matched = collectMatchingFoldPaths(tree, "NEEDLE_TOKEN");
  assert.deepEqual(
    [...matched].sort(),
    ['$."messages"', '$."messages"[1]', '$."messages"[1]."content"'].sort(),
  );

  // Searching a top-level key visible on its own collapsed line does not force-open its body.
  const keyOnly = collectMatchingFoldPaths(tree, "thinking");
  assert.equal(keyOnly.has('$."thinking"'), false);
});

