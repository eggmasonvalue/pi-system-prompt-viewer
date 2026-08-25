import assert from "node:assert/strict";
import test from "node:test";
import {
  renderProviderNeutralContent,
  renderStructured,
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
