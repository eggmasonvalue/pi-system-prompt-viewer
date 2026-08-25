export interface ProviderNeutralToolInput {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
}

export interface ProviderNeutralTool {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
}

export interface ProviderNeutralContent {
  systemPrompt: string;
  tools: ProviderNeutralTool[];
}

const MULTILINE_START = "<<< multiline string >>>";
const MULTILINE_END = "<<< end multiline string >>>";

/** Serialize the provider hook payload without deduplicating or rewriting it. */
export function serializeProviderPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, null, 2);
    return serialized === undefined ? String(payload) : serialized;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `[Provider payload could not be serialized: ${reason}]`;
  }
}

/**
 * Render a JSON-shaped value as readable structure. Unlike JSON.stringify,
 * multiline strings remain multiline. The markers are display delimiters only;
 * the string's characters, including duplicates and line breaks, are untouched.
 */
export function renderStructured(value: unknown): string {
  return renderNode(value).join("\n");
}

function renderNode(value: unknown): string[] {
  if (typeof value === "string") {
    if (!value.includes("\n") && !value.includes("\r")) {
      return [JSON.stringify(value)];
    }
    return [MULTILINE_START, ...value.split(/\r\n?|\n/), MULTILINE_END];
  }

  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return [String(value)];
  }
  if (typeof value !== "object") return [JSON.stringify(String(value))];

  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const lines = ["["];
    value.forEach((item, index) => {
      const childLines = renderNode(item).map((line) => indent(line));
      if (index < value.length - 1) {
        childLines[childLines.length - 1] += ",";
      }
      lines.push(...childLines);
    });
    lines.push("]");
    return lines;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return ["{}"];
  const lines = ["{"];
  entries.forEach(([key, entry], index) => {
    const childLines = renderNode(entry).map((line) => indent(line));
    childLines[0] = `${indent(`${JSON.stringify(key)}: `)}${childLines[0]!.trimStart()}`;
    if (index < entries.length - 1) {
      childLines[childLines.length - 1] += ",";
    }
    lines.push(...childLines);
  });
  lines.push("}");
  return lines;
}

function indent(line: string): string {
  return `  ${line}`;
}

/**
 * Render only the provider-neutral system footprint. Section labels are UI
 * boundaries, not fields in a claimed request envelope.
 */
export function renderProviderNeutralContent(
  content: ProviderNeutralContent,
): string {
  return [
    `System Prompt\n${"─".repeat(13)}\n${content.systemPrompt}`,
    `Tools\n${"─".repeat(5)}\n${renderStructured(content.tools)}`,
  ].join("\n\n");
}

/** Keep only provider-visible tool semantics from ToolInfo-like objects. */
export function toProviderNeutralTool(
  tool: ProviderNeutralToolInput,
): ProviderNeutralTool {
  const descriptor: ProviderNeutralTool = {
    name: tool.name,
    description: tool.description,
    parameters: cloneSnapshotValue(tool.parameters),
  };

  if ("constrainedSampling" in tool && tool.constrainedSampling !== undefined) {
    descriptor.constrainedSampling = cloneSnapshotValue(
      tool.constrainedSampling,
    );
  }

  return descriptor;
}

function cloneSnapshotValue<T>(value: T): T {
  const clone = (globalThis as { structuredClone?: <V>(input: V) => V })
    .structuredClone;
  if (clone) {
    try {
      return clone(value);
    } catch {
      // Fall through to JSON for unusual extension values.
    }
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
