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

export interface SystemPromptLandmark {
  lineIndex: number;
  label: string;
}

export type SystemPromptLineTagKind =
  | "xml-open"
  | "xml-close"
  | "xml-inline"
  | "markdown-heading";

export interface SystemPromptAnalysis {
  landmarks: SystemPromptLandmark[];
  taggedLines: Map<number, SystemPromptLineTagKind>;
}

export type StructuredNode =
  | {
      kind: "scalar";
      text: string;
    }
  | {
      kind: "multiline";
      path: string;
      lines: readonly string[];
    }
  | {
      kind: "array";
      path: string;
      items: readonly StructuredNode[];
    }
  | {
      kind: "object";
      path: string;
      entries: readonly {
        key: string;
        keyJson: string;
        value: StructuredNode;
      }[];
    };

export interface StructuredDisplayLine {
  text: string;
  inMultilineBody: boolean;
  foldPath?: string;
  collapsed?: boolean;
  topLevelKey?: string;
}

export const MULTILINE_START = "<<< multiline string >>>";
export const MULTILINE_END = "<<< end multiline string >>>";
export const MULTILINE_COLLAPSED = "<<< multiline string … >>>";
export const OBJECT_COLLAPSED = "{ … }";
export const ARRAY_COLLAPSED = "[ … ]";

export const SYSTEM_SECTION_HEADINGS = ["System Prompt", "Tools"] as const;
export const PROVIDER_DIAGNOSTICS_HEADINGS = [
  "Request Headers (redacted)",
  "Latest HTTP Response",
  "Payload",
] as const;

const SMART_COLLAPSE_ARRAY_THRESHOLD = 3;
const SMART_COLLAPSE_MULTILINE_THRESHOLD = 8;

const INLINE_XML_TAG_RE = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>.*<\/\1>\s*$/;
const OPEN_XML_TAG_RE = /^<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>$/;
const CLOSE_XML_TAG_RE = /^<\/([A-Za-z][\w.:-]*)>\s*$/;
const MARKDOWN_HEADING_RE = /^#{1,3}\s+\S.*$/;
const CODE_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

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
 * Build an immutable, cycle-safe tree representation of a structured value.
 * Preserves duplicate values, exact key ordering, and multiline string lines.
 */
export function buildStructuredTree(value: unknown): StructuredNode {
  return buildNode(value, "$", new WeakSet<object>());
}

function buildNode(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): StructuredNode {
  if (typeof value === "string") {
    if (!value.includes("\n") && !value.includes("\r")) {
      return { kind: "scalar", text: JSON.stringify(value) };
    }
    return {
      kind: "multiline",
      path,
      lines: value.split(/\r\n?|\n/),
    };
  }

  if (value === null) return { kind: "scalar", text: "null" };
  if (value === undefined) return { kind: "scalar", text: "undefined" };
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return { kind: "scalar", text: String(value) };
  }
  if (typeof value !== "object") {
    return { kind: "scalar", text: JSON.stringify(String(value)) };
  }

  if (seen.has(value)) {
    return { kind: "scalar", text: '"[Circular]"' };
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return { kind: "scalar", text: "[]" };
      return {
        kind: "array",
        path,
        items: value.map((item, index) =>
          buildNode(item, `${path}[${index}]`, seen),
        ),
      };
    }

    const rawEntries = Object.entries(value as Record<string, unknown>);
    if (rawEntries.length === 0) return { kind: "scalar", text: "{}" };
    return {
      kind: "object",
      path,
      entries: rawEntries.map(([key, entry]) => {
        const keyJson = JSON.stringify(key);
        return {
          key,
          keyJson,
          value: buildNode(entry, `${path}.${keyJson}`, seen),
        };
      }),
    };
  } finally {
    seen.delete(value);
  }
}

export function isFoldableNode(
  node: StructuredNode,
): node is Exclude<StructuredNode, { kind: "scalar" }> {
  return node.kind !== "scalar";
}

/**
 * Compute the default smart-collapsed fold set for a provider payload tree.
 * Top-level sections, array items in top-level or multi-item lists, and long
 * multiline strings start folded using pure structural delimiters (no preview text).
 */
export function collectSmartCollapsedPaths(root: StructuredNode): Set<string> {
  const collapsed = new Set<string>();

  const visit = (
    node: StructuredNode,
    depth: number,
    parentCollapsesItems: boolean,
  ): void => {
    if (depth >= 1 && isFoldableNode(node)) {
      const shouldCollapse =
        depth === 1 ||
        parentCollapsesItems ||
        (node.kind === "array" &&
          node.items.length > SMART_COLLAPSE_ARRAY_THRESHOLD) ||
        (node.kind === "multiline" &&
          node.lines.length > SMART_COLLAPSE_MULTILINE_THRESHOLD);
      if (shouldCollapse) {
        collapsed.add(node.path);
      }
    }

    if (node.kind === "object") {
      for (const entry of node.entries) {
        visit(entry.value, depth + 1, false);
      }
    } else if (node.kind === "array") {
      const collapseItems =
        depth <= 1 || node.items.length > SMART_COLLAPSE_ARRAY_THRESHOLD;
      for (const item of node.items) {
        visit(item, depth + 1, collapseItems);
      }
    }
  };

  visit(root, 0, false);
  return collapsed;
}

/**
 * Find foldable node paths whose interior contains a case-insensitive match
 * for `query`, so search can reveal folded matches without losing hits.
 */
export function collectMatchingFoldPaths(
  root: StructuredNode,
  query: string,
): Set<string> {
  const needle = query.trim().toLowerCase();
  const matches = new Set<string>();
  if (!needle) return matches;

  const visit = (node: StructuredNode, depth: number): boolean => {
    if (node.kind === "scalar") {
      return node.text.toLowerCase().includes(needle);
    }

    if (node.kind === "multiline") {
      const hit =
        MULTILINE_START.includes(needle) ||
        MULTILINE_END.includes(needle) ||
        node.lines.some((line) => line.toLowerCase().includes(needle));
      if (hit && depth >= 1) {
        matches.add(node.path);
      }
      return hit;
    }

    if (node.kind === "array") {
      let anyHit = false;
      for (const item of node.items) {
        if (visit(item, depth + 1)) {
          anyHit = true;
        }
      }
      if (anyHit && depth >= 1) {
        matches.add(node.path);
      }
      return anyHit;
    }

    let anyHit = false;
    for (const entry of node.entries) {
      const keyHit = entry.keyJson.toLowerCase().includes(needle);
      const valueHit = visit(entry.value, depth + 1);
      if (keyHit || valueHit) {
        anyHit = true;
      }
    }
    if (anyHit && depth >= 1) {
      matches.add(node.path);
    }
    return anyHit;
  };

  visit(root, 0);
  return matches;
}

/**
 * Render a `StructuredNode` tree into display lines, honoring `collapsedPaths`.
 * Collapsed nodes emit pure structural delimiters (`{ … }`, `[ … ]`,
 * `<<< multiline string … >>>`) without synthesizing or modifying inner text.
 */
export function renderStructuredTree(
  root: StructuredNode,
  collapsedPaths: ReadonlySet<string> = new Set(),
): StructuredDisplayLine[] {
  const output: StructuredDisplayLine[] = [];

  const emit = (
    node: StructuredNode,
    depth: number,
    keyPrefix: string,
    comma: string,
    topLevelKey?: string,
  ): void => {
    const pad = "  ".repeat(depth);

    if (node.kind === "scalar") {
      output.push({
        text: `${pad}${keyPrefix}${node.text}${comma}`,
        inMultilineBody: false,
        topLevelKey,
      });
      return;
    }

    const foldable = depth >= 1;
    const isCollapsed = foldable && collapsedPaths.has(node.path);

    if (node.kind === "multiline") {
      if (isCollapsed) {
        output.push({
          text: `${pad}${keyPrefix}${MULTILINE_COLLAPSED}${comma}`,
          inMultilineBody: false,
          foldPath: node.path,
          collapsed: true,
          topLevelKey,
        });
        return;
      }

      output.push({
        text: `${pad}${keyPrefix}${MULTILINE_START}`,
        inMultilineBody: false,
        foldPath: foldable ? node.path : undefined,
        collapsed: foldable ? false : undefined,
        topLevelKey,
      });
      for (const bodyLine of node.lines) {
        output.push({
          text: `${pad}${bodyLine}`,
          inMultilineBody: true,
        });
      }
      output.push({
        text: `${pad}${MULTILINE_END}${comma}`,
        inMultilineBody: false,
      });
      return;
    }

    if (node.kind === "array") {
      if (isCollapsed) {
        output.push({
          text: `${pad}${keyPrefix}${ARRAY_COLLAPSED}${comma}`,
          inMultilineBody: false,
          foldPath: node.path,
          collapsed: true,
          topLevelKey,
        });
        return;
      }

      output.push({
        text: `${pad}${keyPrefix}[`,
        inMultilineBody: false,
        foldPath: foldable ? node.path : undefined,
        collapsed: foldable ? false : undefined,
        topLevelKey,
      });
      node.items.forEach((item, index) => {
        const childComma = index < node.items.length - 1 ? "," : "";
        emit(item, depth + 1, "", childComma);
      });
      output.push({
        text: `${pad}]${comma}`,
        inMultilineBody: false,
      });
      return;
    }

    if (isCollapsed) {
      output.push({
        text: `${pad}${keyPrefix}${OBJECT_COLLAPSED}${comma}`,
        inMultilineBody: false,
        foldPath: node.path,
        collapsed: true,
        topLevelKey,
      });
      return;
    }

    output.push({
      text: `${pad}${keyPrefix}{`,
      inMultilineBody: false,
      foldPath: foldable ? node.path : undefined,
      collapsed: foldable ? false : undefined,
      topLevelKey,
    });
    node.entries.forEach((entry, index) => {
      const childComma = index < node.entries.length - 1 ? "," : "";
      const sectionKey =
        depth === 0 && isFoldableNode(entry.value) ? entry.key : undefined;
      emit(
        entry.value,
        depth + 1,
        `${entry.keyJson}: `,
        childComma,
        sectionKey,
      );
    });
    output.push({
      text: `${pad}}${comma}`,
      inMultilineBody: false,
    });
  };

  emit(root, 0, "", "");
  return output;
}

/**
 * Render a JSON-shaped value as readable structure. Unlike JSON.stringify,
 * multiline strings remain multiline. The markers are display delimiters only;
 * the string's characters, including duplicates and line breaks, are untouched.
 */
export function renderStructured(value: unknown): string {
  return renderStructuredTree(buildStructuredTree(value))
    .map((line) => line.text)
    .join("\n");
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

/**
 * Identify top-level structural landmarks inside an assembled system prompt:
 * column-0 paired XML blocks (`<tools>`, `<rules>`, `<skills>`, `<cwd>`, etc.)
 * and top-level Markdown headings outside XML blocks and fenced code blocks.
 */
export function analyzeSystemPrompt(
  systemPrompt: string,
): SystemPromptAnalysis {
  const lines = systemPrompt.split("\n");
  const inFence = computeFencedLines(lines);
  const landmarks: SystemPromptLandmark[] = [];
  const taggedLines = new Map<number, SystemPromptLineTagKind>();
  const xmlStack: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    if (inFence[index]) continue;
    const trimmedEnd = lines[index]!.trimEnd();
    if (!trimmedEnd) continue;

    if (xmlStack.length > 0) {
      const currentTop = xmlStack[xmlStack.length - 1]!;
      if (INLINE_XML_TAG_RE.test(trimmedEnd)) {
        continue;
      }
      const openTag = matchStandaloneOpenXmlTag(trimmedEnd);
      if (
        openTag === currentTop &&
        hasMatchingCloseXmlTag(lines, inFence, index, openTag)
      ) {
        xmlStack.push(openTag);
        continue;
      }
      const closeMatch = CLOSE_XML_TAG_RE.exec(trimmedEnd);
      if (closeMatch && closeMatch[1] === currentTop) {
        xmlStack.pop();
        if (xmlStack.length === 0) {
          taggedLines.set(index, "xml-close");
        }
      }
      continue;
    }

    const inlineMatch = INLINE_XML_TAG_RE.exec(trimmedEnd);
    if (inlineMatch) {
      landmarks.push({ lineIndex: index, label: `<${inlineMatch[1]!}>` });
      taggedLines.set(index, "xml-inline");
      continue;
    }

    const openTag = matchStandaloneOpenXmlTag(trimmedEnd);
    if (openTag && hasMatchingCloseXmlTag(lines, inFence, index, openTag)) {
      landmarks.push({ lineIndex: index, label: `<${openTag}>` });
      taggedLines.set(index, "xml-open");
      xmlStack.push(openTag);
      continue;
    }

    if (MARKDOWN_HEADING_RE.test(trimmedEnd)) {
      landmarks.push({ lineIndex: index, label: trimmedEnd });
      taggedLines.set(index, "markdown-heading");
    }
  }

  return { landmarks, taggedLines };
}

function computeFencedLines(lines: readonly string[]): boolean[] {
  const inFence = new Array<boolean>(lines.length).fill(false);
  let activeChar = "";
  let activeLen = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!activeChar) {
      const open = CODE_FENCE_OPEN_RE.exec(line);
      if (open) {
        const marker = open[1]!;
        activeChar = marker[0]!;
        activeLen = marker.length;
        inFence[index] = true;
      }
      continue;
    }

    inFence[index] = true;
    const closeRe = new RegExp(`^ {0,3}${activeChar}{${activeLen},}\\s*$`);
    if (closeRe.test(line.trimEnd())) {
      activeChar = "";
      activeLen = 0;
    }
  }

  return inFence;
}

function matchStandaloneOpenXmlTag(trimmedEnd: string): string | undefined {
  if (trimmedEnd.endsWith("/>")) return undefined;
  const match = OPEN_XML_TAG_RE.exec(trimmedEnd);
  return match?.[1];
}

function hasMatchingCloseXmlTag(
  lines: readonly string[],
  inFence: readonly boolean[],
  openIndex: number,
  tagName: string,
): boolean {
  let depth = 1;
  for (let index = openIndex + 1; index < lines.length; index++) {
    if (inFence[index]) continue;
    const trimmedEnd = lines[index]!.trimEnd();
    if (!trimmedEnd || INLINE_XML_TAG_RE.test(trimmedEnd)) continue;

    const nestedOpen = matchStandaloneOpenXmlTag(trimmedEnd);
    if (nestedOpen === tagName) {
      depth++;
      continue;
    }

    const closeMatch = CLOSE_XML_TAG_RE.exec(trimmedEnd);
    if (closeMatch && closeMatch[1] === tagName) {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
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
