export type ViewerMode = "system" | "provider";

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

export interface ProviderResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  responseCount: number;
}

export interface SearchMatch {
  lineIndex: number;
  start: number;
  end: number;
}

export const MULTILINE_START = "<<< multiline string >>>";
export const MULTILINE_END = "<<< end multiline string >>>";

export const SYSTEM_SECTION_HEADINGS = ["System Prompt", "Tools"] as const;
export const PROVIDER_DIAGNOSTICS_HEADINGS = [
  "Request Headers (redacted)",
  "Latest HTTP Response",
  "Payload",
] as const;

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-goog-api-key",
  "x-amz-security-token",
]);
const SENSITIVE_HEADER_SEGMENT =
  /(^|[-_])(authorization|auth|api[-_]?key|token|secret|password|passwd|cookie|credential|signature)($|[-_])/i;

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
  return renderNode(value, new WeakSet<object>()).join("\n");
}

function renderNode(value: unknown, seen: WeakSet<object>): string[] {
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

  if (seen.has(value)) return ['"[Circular]"'];
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return ["[]"];
      const lines = ["["];
      value.forEach((item, index) => {
        const childLines = renderNode(item, seen).map((line) => indent(line));
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
      const childLines = renderNode(entry, seen).map((line) => indent(line));
      childLines[0] = `${indent(`${JSON.stringify(key)}: `)}${childLines[0]!.trimStart()}`;
      if (index < entries.length - 1) {
        childLines[childLines.length - 1] += ",";
      }
      lines.push(...childLines);
    });
    lines.push("}");
    return lines;
  } finally {
    seen.delete(value);
  }
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
    formatSection("System Prompt", content.systemPrompt),
    formatSection("Tools", renderStructured(content.tools)),
  ].join("\n\n");
}

/**
 * Render HTTP headers and latest response diagnostics above the provider
 * payload for interactive inspection. Never used as the payload JSON copy.
 */
export function renderProviderDiagnostics(options: {
  requestHeaders?: Record<string, string>;
  response?: ProviderResponseSnapshot;
  payloadDisplay: string;
}): string {
  const sections: string[] = [];

  sections.push(
    formatSection(
      "Request Headers (redacted)",
      options.requestHeaders
        ? renderStructured(options.requestHeaders)
        : "Not exposed by this provider/transport.",
    ),
  );

  sections.push(
    formatSection(
      "Latest HTTP Response",
      options.response
        ? renderStructured({
            status: options.response.status,
            responsesObserved: options.response.responseCount,
            headers: options.response.headers,
          })
        : "No HTTP response observed yet for this request.",
    ),
  );

  sections.push(formatSection("Payload", options.payloadDisplay));
  return sections.join("\n\n");
}

function formatSection(heading: string, body: string): string {
  return `${heading}\n${"─".repeat(heading.length)}\n${body}`;
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

/** Exclude tool declarations hidden by `prepareLoadout` (`hiddenTools`). */
export function filterVisibleTools<T extends { name: string }>(
  tools: readonly T[],
  hiddenToolNames?: Iterable<string>,
): T[] {
  if (!hiddenToolNames) return [...tools];
  const hidden = new Set(hiddenToolNames);
  if (hidden.size === 0) return [...tools];
  return tools.filter((tool) => !hidden.has(tool.name));
}

/**
 * Copy HTTP headers for inspection, dropping null/undefined entries and
 * redacting credential/auth header values.
 */
export function redactHeaders(
  headers: Record<string, string | null | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined) continue;
    result[name] = isSensitiveHeader(name) ? REDACTED_VALUE : value;
  }
  return result;
}

function isSensitiveHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(normalized) ||
    SENSITIVE_HEADER_SEGMENT.test(normalized)
  );
}

/** Find all non-overlapping case-insensitive substring matches across lines. */
export function findSearchMatches(
  lines: readonly string[],
  query: string,
): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const haystack = lines[lineIndex]!.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      matches.push({ lineIndex, start, end });
      from = end;
    }
  }
  return matches;
}

/**
 * Locate line indices of rendered section headings (`Heading\n───`).
 */
export function findSectionLines(
  lines: readonly string[],
  headings: readonly string[],
): number[] {
  const headingSet = new Set(headings);
  const indices: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!headingSet.has(line)) continue;
    const next = lines[index + 1];
    if (next === "─".repeat(line.length)) {
      indices.push(index);
    }
  }
  return indices;
}

/** Parse `/system-context [system|provider]` arguments. */
export function parseViewerCommandMode(args: string): ViewerMode | undefined {
  const normalized = args.trim().toLowerCase();
  if (normalized === "" || normalized === "system") return "system";
  if (normalized === "provider") return "provider";
  return undefined;
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
