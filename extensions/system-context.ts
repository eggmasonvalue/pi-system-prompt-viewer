/**
 * /system-context — inspect the request footprint exposed by Pi.
 *
 * The primary System Footprint tracks the active system prompt and declared
 * provider-neutral tools via `context_with_system` (with `before_agent_start`
 * and `agent_start` fallbacks), keeping up with mid-run dynamic tool loading,
 * prompt section patches, and `prepareLoadout` overrides/hidden declarations.
 *
 * Provider Request captures the latest `before_provider_request` payload along
 * with redacted `before_provider_headers` and `after_provider_response` HTTP
 * diagnostics.
 */
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type NormalizedBuildSystemPromptOptions,
  type Theme,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type Component,
  type Focusable,
  Input,
  matchesKey,
  type OverlayHandle,
  replaceControlCharacters,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  filterVisibleTools,
  findSearchMatches,
  findSectionLines,
  MULTILINE_END,
  MULTILINE_START,
  PROVIDER_DIAGNOSTICS_HEADINGS,
  type ProviderNeutralContent,
  type ProviderResponseSnapshot,
  parseViewerCommandMode,
  redactHeaders,
  renderProviderDiagnostics,
  renderProviderNeutralContent,
  renderStructured,
  type SearchMatch,
  SYSTEM_SECTION_HEADINGS,
  serializeProviderPayload,
  toProviderNeutralTool,
  type ViewerMode,
} from "../lib/footprint-model.ts";

type SystemSnapshotSource = "context_with_system" | "agent_start" | "idle";

interface SystemSnapshot {
  content: ProviderNeutralContent;
  source: SystemSnapshotSource;
  hiddenToolCount: number;
  forcedPrompt: boolean;
}

interface ProviderSnapshot {
  displayText: string;
  copyText: string;
  label?: string;
  requestNumber: number;
  requestCount: number;
  requestHeaders?: Record<string, string>;
  response?: ProviderResponseSnapshot;
}

type LineKind = "plain" | "heading" | "rule" | "delimiter" | "structured";

interface WrappedLine {
  text: string;
  kind: LineKind;
}

interface StyledSegment {
  text: string;
  role?:
    | "heading"
    | "rule"
    | "delimiter"
    | "key"
    | "string"
    | "number"
    | "keyword"
    | "punctuation";
}

interface TabBounds {
  systemStart: number;
  systemEnd: number;
  providerStart: number;
  providerEnd: number;
}

const CHROME_ROWS = 8;
const TAB_ROW_Y = 2;
const COPY_FEEDBACK_MS = 2_000;
const COPY_ERROR_FEEDBACK_MS = 3_500;

const COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
  {
    value: "system",
    label: "system",
    description: "Provider-neutral System Footprint (default)",
  },
  {
    value: "provider",
    label: "provider",
    description: "Latest Provider Request payload & HTTP diagnostics",
  },
];

export default function systemPromptViewer(pi: ExtensionAPI) {
  let lastRunPromptOptions: NormalizedBuildSystemPromptOptions | undefined;
  let systemSnapshot: SystemSnapshot | undefined;
  let providerRequestCount = 0;
  let pendingRequestHeaders: Record<string, string> | undefined;
  let latestProvider: ProviderSnapshot | undefined;

  const resetState = () => {
    lastRunPromptOptions = undefined;
    systemSnapshot = undefined;
    providerRequestCount = 0;
    pendingRequestHeaders = undefined;
    latestProvider = undefined;
  };

  pi.on("before_agent_start", (event) => {
    lastRunPromptOptions = event.systemPromptOptions;
  });

  pi.on("agent_start", (_event, ctx) => {
    providerRequestCount = 0;
    pendingRequestHeaders = undefined;
    latestProvider = undefined;
    systemSnapshot = makeFallbackSystemSnapshot(
      pi,
      ctx,
      "agent_start",
      lastRunPromptOptions?.hiddenTools,
      lastRunPromptOptions?.forceSystemPrompt !== undefined,
    );
  });

  pi.on("context_with_system", (event, ctx) => {
    const hiddenTools = lastRunPromptOptions?.hiddenTools ?? [];
    const declaredTools = getCurrentTools(event.messages);
    const visibleTools = filterVisibleTools(declaredTools, hiddenTools);
    const forcedPrompt = lastRunPromptOptions?.forceSystemPrompt !== undefined;
    const systemPrompt = forcedPrompt
      ? ctx.getSystemPrompt()
      : getCurrentSystemPrompt(event.messages) || ctx.getSystemPrompt();

    systemSnapshot = {
      content: {
        systemPrompt,
        tools: visibleTools.map((tool) =>
          toProviderNeutralTool(toToolDeclaration(tool)),
        ),
      },
      source: "context_with_system",
      hiddenToolCount: declaredTools.length - visibleTools.length,
      forcedPrompt,
    };
  });

  pi.on("before_provider_headers", (event) => {
    pendingRequestHeaders = redactHeaders(event.headers);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const requestNumber = ++providerRequestCount;
    latestProvider = {
      displayText: renderStructured(event.payload),
      copyText: serializeProviderPayload(event.payload),
      label: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      requestNumber,
      requestCount: providerRequestCount,
      requestHeaders: pendingRequestHeaders,
      response: undefined,
    };
    pendingRequestHeaders = undefined;
  });

  pi.on("after_provider_response", (event) => {
    if (!latestProvider) return;
    latestProvider.response = {
      status: event.status,
      headers: redactHeaders(event.headers),
      responseCount: (latestProvider.response?.responseCount ?? 0) + 1,
    };
  });

  pi.on("session_shutdown", () => {
    resetState();
  });

  pi.registerCommand("system-context", {
    description: "Show the system footprint or latest provider payload",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const normalized = prefix.trim().toLowerCase();
      const filtered = COMMAND_COMPLETIONS.filter((item) =>
        item.value.startsWith(normalized),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "/system-context is available in interactive Pi only.",
          "warning",
        );
        return;
      }

      const initialMode = parseViewerCommandMode(args);
      if (!initialMode) {
        ctx.ui.notify("Usage: /system-context [system|provider]", "warning");
        return;
      }

      await ctx.waitForIdle();
      const baseOptions = ctx.getSystemPromptOptions();
      const snapshot = systemSnapshot
        ? applyHiddenTools(systemSnapshot, baseOptions.hiddenTools)
        : makeFallbackSystemSnapshot(
            pi,
            ctx,
            "idle",
            baseOptions.hiddenTools,
            baseOptions.forceSystemPrompt !== undefined,
          );

      let viewer: RequestFootprintViewer | undefined;
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          viewer = new RequestFootprintViewer(
            tui,
            theme,
            keybindings,
            initialMode,
            snapshot,
            latestProvider,
            done,
            (message, type) => ctx.ui.notify(message, type),
          );
          return viewer;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "95%",
            maxHeight: "92%",
            margin: 0,
          },
          onHandle: (handle) => {
            viewer?.setOverlayHandle(handle);
          },
        },
      );
    },
  });
}

function applyHiddenTools(
  snapshot: SystemSnapshot,
  hiddenTools: readonly string[] | undefined,
): SystemSnapshot {
  if (!hiddenTools || hiddenTools.length === 0) return snapshot;
  const visibleTools = filterVisibleTools(snapshot.content.tools, hiddenTools);
  const newlyHidden = snapshot.content.tools.length - visibleTools.length;
  if (newlyHidden === 0) return snapshot;
  return {
    ...snapshot,
    content: {
      ...snapshot.content,
      tools: visibleTools,
    },
    hiddenToolCount: snapshot.hiddenToolCount + newlyHidden,
  };
}

function makeFallbackSystemSnapshot(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "getSystemPrompt">,
  source: Exclude<SystemSnapshotSource, "context_with_system">,
  hiddenTools: readonly string[] | undefined,
  forcedPrompt: boolean,
): SystemSnapshot {
  const active = new Set(pi.getActiveTools());
  const activeTools = pi
    .getAllTools()
    .filter((tool: ToolInfo) => active.has(tool.name));
  const visibleTools = filterVisibleTools(activeTools, hiddenTools);

  return {
    content: {
      systemPrompt: ctx.getSystemPrompt(),
      tools: visibleTools.map((tool) => toProviderNeutralTool(tool)),
    },
    source,
    hiddenToolCount: activeTools.length - visibleTools.length,
    forcedPrompt,
  };
}

class RequestFootprintViewer implements Component, Focusable {
  private _focused = false;
  private mode: ViewerMode;
  private showHeaders = false;
  private scrollOffset = 0;
  private overlayHandle?: OverlayHandle;

  private copyStatus: "idle" | "copied" | "error" = "idle";
  private copyTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  private readonly systemText: string;
  private readonly systemSnapshot: SystemSnapshot;
  private readonly provider?: ProviderSnapshot;
  private readonly providerPayloadDisplay: string;
  private readonly providerDiagnosticsDisplay: string;
  private readonly providerCopyText: string;

  private readonly searchInput: Input;
  private searchEditing = false;
  private searchQuery = "";
  private searchMatches: SearchMatch[] = [];
  private searchMatchesByLine = new Map<number, SearchMatch[]>();
  private currentMatchIndex = -1;

  private cachedLinesKey = "";
  private cachedWrappedLines: WrappedLine[] = [];
  private cachedSectionLines: number[] = [];
  private cachedMatchesQuery = "";
  private lastTabBounds?: TabBounds;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    initialMode: ViewerMode,
    systemSnapshot: SystemSnapshot,
    provider: ProviderSnapshot | undefined,
    private readonly done: () => void,
    private readonly notify: (
      message: string,
      type?: "info" | "warning" | "error",
    ) => void,
  ) {
    this.mode = initialMode;
    this.systemSnapshot = systemSnapshot;
    this.systemText = renderProviderNeutralContent(systemSnapshot.content);
    this.provider = provider;
    this.providerPayloadDisplay =
      provider?.displayText ??
      [
        "No before_provider_request payload was captured for this run.",
        "",
        "Use the System Footprint view for the captured semantic system context.",
      ].join("\n");
    this.providerDiagnosticsDisplay = provider
      ? renderProviderDiagnostics({
          requestHeaders: provider.requestHeaders,
          response: provider.response,
          payloadDisplay: this.providerPayloadDisplay,
        })
      : this.providerPayloadDisplay;
    this.providerCopyText = provider?.copyText ?? this.providerPayloadDisplay;

    this.searchInput = new Input({
      prompt: "/ ",
      placeholder: "search (Enter to jump, Esc to cancel)",
      placeholderStyle: (text) => this.theme.fg("dim", text),
    });
    this.searchInput.onSubmit = (value) => {
      this.searchEditing = false;
      this.syncInputFocus();
      this.applySearchQuery(value, true);
      this.tui.requestRender();
    };
    this.searchInput.onEscape = () => {
      this.searchEditing = false;
      this.syncInputFocus();
      this.applySearchQuery("", false);
      this.tui.requestRender();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  setOverlayHandle(handle: OverlayHandle): void {
    this.overlayHandle = handle;
  }

  handleInput(data: string): void {
    if (this.searchEditing) {
      this.searchInput.handleInput(data);
      if (this.searchEditing) {
        this.applySearchQuery(this.searchInput.getValue(), true);
      }
      this.tui.requestRender();
      return;
    }

    if (
      matchesKey(data, "tab") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      this.switchMode(this.mode === "system" ? "provider" : "system");
      return;
    }

    if (matchesKey(data, "h") && this.mode === "provider" && this.provider) {
      this.showHeaders = !this.showHeaders;
      this.scrollOffset = 0;
      this.invalidateLines();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "s")) {
      this.jumpToNextSection();
      return;
    }

    if (matchesKey(data, "/")) {
      this.searchEditing = true;
      this.searchInput.setValue(this.searchQuery);
      this.syncInputFocus();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "n") && this.searchQuery) {
      this.stepSearchMatch(1);
      return;
    }

    if (matchesKey(data, "shift+n") && this.searchQuery) {
      this.stepSearchMatch(-1);
      return;
    }

    if (matchesKey(data, "c")) {
      void this.copyActiveView();
      return;
    }

    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, "q")
    ) {
      if (
        this.searchQuery &&
        this.keybindings.matches(data, "tui.select.cancel") &&
        !matchesKey(data, "ctrl+c")
      ) {
        this.applySearchQuery("", false);
        this.tui.requestRender();
        return;
      }
      this.dispose();
      this.done();
      return;
    }

    const visible = this.visibleLineCount();
    const maximumOffset = this.maxScrollOffset(visible);

    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + 1);
    } else if (
      this.keybindings.matches(data, "tui.select.pageUp") ||
      matchesKey(data, "u") ||
      matchesKey(data, "ctrl+u")
    ) {
      this.scrollOffset = Math.max(0, this.scrollOffset - visible);
    } else if (
      this.keybindings.matches(data, "tui.select.pageDown") ||
      matchesKey(data, "d") ||
      matchesKey(data, "ctrl+d") ||
      matchesKey(data, "space")
    ) {
      this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + visible);
    } else if (matchesKey(data, "home") || matchesKey(data, "g")) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.scrollOffset = maximumOffset;
    } else {
      return;
    }

    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return { handled: true, render: false };
      const maximumOffset = this.maxScrollOffset(this.visibleLineCount());
      const next = Math.max(
        0,
        Math.min(maximumOffset, this.scrollOffset + delta),
      );
      const changed = next !== this.scrollOffset;
      this.scrollOffset = next;
      return { handled: true, render: changed };
    }

    if (
      event.type === "click" &&
      event.button === "left" &&
      event.y === TAB_ROW_Y &&
      this.lastTabBounds
    ) {
      const { systemStart, systemEnd, providerStart, providerEnd } =
        this.lastTabBounds;
      if (event.x >= systemStart && event.x < systemEnd) {
        this.switchMode("system");
        return { handled: true, render: true };
      }
      if (event.x >= providerStart && event.x < providerEnd) {
        this.switchMode("provider");
        return { handled: true, render: true };
      }
    }

    return { handled: true, render: false };
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const contentWidth = Math.max(1, innerWidth - 2);
    this.ensureWrappedLines(contentWidth);

    const visible = this.visibleLineCount();
    const totalLines = this.cachedWrappedLines.length;
    this.scrollOffset = Math.min(
      this.scrollOffset,
      Math.max(0, totalLines - visible),
    );

    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string, rightBorder = border("│")) =>
      `${border("│")}${pad(content, innerWidth)}${rightBorder}`;

    const title =
      this.mode === "system"
        ? "Provider-neutral System Footprint"
        : "Provider Request";

    const systemLabel = "System Footprint";
    const providerLabel = "Provider Request";
    const systemTab =
      this.mode === "system"
        ? this.theme.fg("accent", this.theme.bold(systemLabel))
        : this.theme.fg("dim", systemLabel);
    const providerTab =
      this.mode === "provider"
        ? this.theme.fg("accent", this.theme.bold(providerLabel))
        : this.theme.fg("dim", providerLabel);

    // Coordinates include the 1-column left border plus 1-column leading space.
    const systemStart = 2;
    const systemEnd = systemStart + visibleWidth(systemLabel);
    const providerStart = systemEnd + 2;
    const providerEnd = providerStart + visibleWidth(providerLabel);
    this.lastTabBounds = {
      systemStart,
      systemEnd,
      providerStart,
      providerEnd,
    };

    const tabRightBadge = this.buildTabBadge();
    const tabLeft = ` ${systemTab}  ${providerTab}`;
    const tabLine = tabRightBadge
      ? joinLeftRight(tabLeft, `${tabRightBadge} `, innerWidth)
      : tabLeft;

    const output: string[] = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold(title))}`),
      row(tabLine),
      row(` ${this.theme.fg("dim", this.modeDescription())}`),
      border(`├${"─".repeat(innerWidth)}┤`),
    ];

    const end = Math.min(this.scrollOffset + visible, totalLines);
    const activeMatch =
      this.currentMatchIndex >= 0
        ? this.searchMatches[this.currentMatchIndex]
        : undefined;
    const scrollbar = computeScrollbar(totalLines, visible, this.scrollOffset);

    for (let rowOffset = 0; rowOffset < visible; rowOffset++) {
      const lineIndex = this.scrollOffset + rowOffset;
      const rightBorder = renderScrollbarCell(scrollbar, rowOffset, this.theme);
      if (lineIndex < end) {
        const line = this.cachedWrappedLines[lineIndex]!;
        const lineMatches = this.searchMatchesByLine.get(lineIndex) ?? [];
        const rendered = renderStyledLine(
          line,
          lineMatches,
          activeMatch,
          this.theme,
        );
        output.push(row(` ${rendered}`, rightBorder));
      } else {
        output.push(row("", rightBorder));
      }
    }

    output.push(border(`├${"─".repeat(innerWidth)}┤`));
    output.push(row(this.renderFooter(innerWidth, totalLines, end)));
    output.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return output;
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.copyTimer);
    this.copyTimer = undefined;
  }

  private switchMode(nextMode: ViewerMode): void {
    if (this.mode === nextMode) return;
    this.mode = nextMode;
    this.scrollOffset = 0;
    this.invalidateLines();
    this.tui.requestRender();
  }

  private syncInputFocus(): void {
    this.searchInput.focused = this._focused && this.searchEditing;
  }

  private invalidateLines(): void {
    this.cachedLinesKey = "";
    this.cachedMatchesQuery = "";
  }

  private activeDisplayText(): string {
    if (this.mode === "system") return this.systemText;
    return this.showHeaders
      ? this.providerDiagnosticsDisplay
      : this.providerPayloadDisplay;
  }

  private activeSectionHeadings(): readonly string[] {
    if (this.mode === "system") return SYSTEM_SECTION_HEADINGS;
    return this.showHeaders ? PROVIDER_DIAGNOSTICS_HEADINGS : [];
  }

  private ensureWrappedLines(contentWidth: number): void {
    const key = `${this.mode}:${this.showHeaders ? 1 : 0}:${contentWidth}`;
    if (this.cachedLinesKey !== key) {
      const text = this.activeDisplayText();
      const headings = this.activeSectionHeadings();
      const structuredMode = this.mode === "provider";
      this.cachedWrappedLines = wrapDocument(
        text,
        contentWidth,
        headings,
        structuredMode,
      );
      this.cachedSectionLines = findSectionLines(
        this.cachedWrappedLines.map((line) => line.text),
        headings,
      );
      this.cachedLinesKey = key;
      this.cachedMatchesQuery = "";
    }

    if (this.cachedMatchesQuery !== this.searchQuery) {
      this.recomputeSearchMatches(false);
    }
  }

  private applySearchQuery(query: string, jumpToNearest: boolean): void {
    this.searchQuery = query;
    this.recomputeSearchMatches(jumpToNearest);
  }

  private recomputeSearchMatches(jumpToNearest: boolean): void {
    this.cachedMatchesQuery = this.searchQuery;
    this.searchMatchesByLine.clear();
    if (!this.searchQuery.trim()) {
      this.searchMatches = [];
      this.currentMatchIndex = -1;
      return;
    }

    this.searchMatches = findSearchMatches(
      this.cachedWrappedLines.map((line) => line.text),
      this.searchQuery,
    );
    for (const match of this.searchMatches) {
      let list = this.searchMatchesByLine.get(match.lineIndex);
      if (!list) {
        list = [];
        this.searchMatchesByLine.set(match.lineIndex, list);
      }
      list.push(match);
    }

    if (this.searchMatches.length === 0) {
      this.currentMatchIndex = -1;
      return;
    }

    if (jumpToNearest || this.currentMatchIndex < 0) {
      const nearest = this.searchMatches.findIndex(
        (match) => match.lineIndex >= this.scrollOffset,
      );
      this.currentMatchIndex = nearest >= 0 ? nearest : 0;
      if (jumpToNearest) {
        this.revealLine(this.searchMatches[this.currentMatchIndex]!.lineIndex);
      }
    } else {
      this.currentMatchIndex = Math.min(
        this.currentMatchIndex,
        this.searchMatches.length - 1,
      );
    }
  }

  private stepSearchMatch(direction: 1 | -1): void {
    if (this.searchMatches.length === 0) return;
    const count = this.searchMatches.length;
    const base = this.currentMatchIndex < 0 ? 0 : this.currentMatchIndex;
    this.currentMatchIndex = (base + direction + count) % count;
    this.revealLine(this.searchMatches[this.currentMatchIndex]!.lineIndex);
    this.tui.requestRender();
  }

  private jumpToNextSection(): void {
    if (this.cachedSectionLines.length === 0) return;
    const next = this.cachedSectionLines.find(
      (lineIndex) => lineIndex > this.scrollOffset,
    );
    const target = next ?? this.cachedSectionLines[0]!;
    const maximumOffset = this.maxScrollOffset(this.visibleLineCount());
    this.scrollOffset = Math.min(maximumOffset, target);
    this.tui.requestRender();
  }

  private revealLine(lineIndex: number): void {
    const visible = this.visibleLineCount();
    const maximumOffset = this.maxScrollOffset(visible);
    if (
      lineIndex >= this.scrollOffset &&
      lineIndex < this.scrollOffset + visible
    ) {
      return;
    }
    const target = lineIndex - Math.floor(visible / 3);
    this.scrollOffset = Math.max(0, Math.min(maximumOffset, target));
  }

  private visibleLineCount(): number {
    const boundsHeight = this.overlayHandle?.getBounds()?.height;
    const overlayHeight =
      boundsHeight && boundsHeight > CHROME_ROWS
        ? boundsHeight
        : Math.floor(this.tui.terminal.rows * 0.92);
    return Math.max(1, overlayHeight - CHROME_ROWS);
  }

  private maxScrollOffset(visible: number): number {
    return Math.max(0, this.cachedWrappedLines.length - visible);
  }

  private buildTabBadge(): string {
    const parts: string[] = [];
    if (this.mode === "provider" && this.provider) {
      if (this.provider.response) {
        const status = this.provider.response.status;
        const statusColor =
          status >= 200 && status < 300
            ? "success"
            : status >= 400
              ? "error"
              : "warning";
        const suffix =
          this.provider.response.responseCount > 1
            ? ` ×${this.provider.response.responseCount}`
            : "";
        parts.push(this.theme.fg(statusColor, `HTTP ${status}${suffix}`));
      }
      if (this.showHeaders) {
        parts.push(this.theme.fg("accent", "headers:on"));
      }
    }
    if (this.searchQuery.trim()) {
      const label =
        this.searchMatches.length > 0
          ? `match ${this.currentMatchIndex + 1}/${this.searchMatches.length}`
          : "no matches";
      parts.push(
        this.theme.fg(
          this.searchMatches.length > 0 ? "accent" : "warning",
          label,
        ),
      );
    }
    return parts.join("  ");
  }

  private modeDescription(): string {
    if (this.mode === "system") {
      const origin =
        this.systemSnapshot.source === "context_with_system"
          ? "latest request context"
          : this.systemSnapshot.source === "agent_start"
            ? "agent-start snapshot"
            : "current idle state";
      const toolCount = `${this.systemSnapshot.content.tools.length} tool${this.systemSnapshot.content.tools.length === 1 ? "" : "s"}`;
      const hidden =
        this.systemSnapshot.hiddenToolCount > 0
          ? ` (${this.systemSnapshot.hiddenToolCount} hidden by loadout)`
          : "";
      const forced = this.systemSnapshot.forcedPrompt ? " • forced prompt" : "";
      return `${origin} • ${toolCount}${hidden}${forced} • c copies system footprint`;
    }
    if (!this.provider) {
      return "No provider payload captured • c copies displayed text";
    }
    const request = `latest payload (${this.provider.requestNumber}/${this.provider.requestCount})`;
    const model = this.provider.label ? ` • ${this.provider.label}` : "";
    const headersHint = this.showHeaders
      ? " • showing redacted headers + payload"
      : " • h headers/response";
    return `${request}${model}${headersHint} • c copies payload JSON`;
  }

  private renderFooter(
    innerWidth: number,
    totalLines: number,
    end: number,
  ): string {
    if (this.searchEditing) {
      const inputWidth = Math.max(1, innerWidth - 2);
      const rendered = this.searchInput.render(inputWidth)[0] ?? "";
      return ` ${rendered}`;
    }

    const range = `${totalLines === 0 ? 0 : this.scrollOffset + 1}-${end}/${totalLines}`;
    const copyLabel =
      this.copyStatus === "copied"
        ? this.theme.fg("success", "copied")
        : this.copyStatus === "error"
          ? this.theme.fg("error", "copy failed")
          : "copy";

    const hints: string[] = ["Tab/←→ view"];
    if (this.cachedSectionLines.length > 1) hints.push("s section");
    if (this.mode === "provider" && this.provider) hints.push("h headers");
    hints.push(this.searchQuery ? "/ search n/N" : "/ search");
    hints.push(`c ${copyLabel}`);
    hints.push("↑↓/jk pgup/dn g/G");
    hints.push("Esc/q");

    const left = ` ${this.theme.fg("dim", range)}`;
    const right = `${this.theme.fg("dim", hints.join("  "))} `;
    return joinLeftRight(left, right, innerWidth);
  }

  private async copyActiveView(): Promise<void> {
    const text =
      this.mode === "system" ? this.systemText : this.providerCopyText;
    try {
      await copyToClipboard(text);
      if (this.disposed) return;
      this.setCopyStatus("copied", COPY_FEEDBACK_MS);
    } catch (error) {
      if (this.disposed) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.notify(reason, "error");
      this.setCopyStatus("error", COPY_ERROR_FEEDBACK_MS);
    }
  }

  private setCopyStatus(
    status: "copied" | "error",
    durationMs: number,
  ): void {
    this.copyStatus = status;
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyStatus = "idle";
      this.copyTimer = undefined;
      if (!this.disposed) this.tui.requestRender();
    }, durationMs);
    this.tui.requestRender();
  }
}

function wrapDocument(
  text: string,
  width: number,
  headings: readonly string[],
  defaultStructured: boolean,
): WrappedLine[] {
  const headingSet = new Set(headings);
  const rawLines = text.split("\n");
  const result: WrappedLine[] = [];

  let inStructuredSection = defaultStructured;
  let inMultiline = false;

  for (let index = 0; index < rawLines.length; index++) {
    const sanitized = sanitizeLine(rawLines[index]!);
    const nextSanitized =
      index + 1 < rawLines.length ? sanitizeLine(rawLines[index + 1]!) : "";
    const trimmed = sanitized.trim();

    let kind: LineKind;
    if (
      !inMultiline &&
      headingSet.has(sanitized) &&
      nextSanitized === "─".repeat(sanitized.length)
    ) {
      kind = "heading";
      inStructuredSection = sanitized !== "System Prompt";
    } else if (
      !inMultiline &&
      index > 0 &&
      headingSet.has(sanitizeLine(rawLines[index - 1]!)) &&
      sanitized === "─".repeat(sanitizeLine(rawLines[index - 1]!).length)
    ) {
      kind = "rule";
    } else if (
      !inMultiline &&
      inStructuredSection &&
      (trimmed === MULTILINE_START ||
        trimmed.endsWith(`: ${MULTILINE_START}`))
    ) {
      kind = trimmed === MULTILINE_START ? "delimiter" : "structured";
      inMultiline = true;
    } else if (
      inMultiline &&
      (trimmed === MULTILINE_END || trimmed === `${MULTILINE_END},`)
    ) {
      kind = trimmed === MULTILINE_END ? "delimiter" : "structured";
      inMultiline = false;
    } else if (inMultiline) {
      kind = "plain";
    } else {
      kind = inStructuredSection ? "structured" : "plain";
    }

    const wrapped = wrapTextWithAnsi(sanitized, width);
    if (wrapped.length === 0) {
      result.push({ text: "", kind });
    } else {
      for (const piece of wrapped) {
        result.push({ text: piece, kind });
      }
    }
  }

  return result;
}

function sanitizeLine(line: string): string {
  return replaceControlCharacters(line.replaceAll("\t", "  "));
}

function tokenizeLine(line: WrappedLine): StyledSegment[] {
  const { text, kind } = line;
  if (!text) return [];
  if (kind === "heading") return [{ text, role: "heading" }];
  if (kind === "rule") return [{ text, role: "rule" }];
  if (kind === "delimiter") return [{ text, role: "delimiter" }];
  if (kind === "plain") return [{ text }];

  return tokenizeStructuredLine(text);
}

function tokenizeStructuredLine(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  const push = (chunk: string, role?: StyledSegment["role"]) => {
    if (chunk) segments.push({ text: chunk, role });
  };

  // Match indented `"key": <rest>`
  const keyMatch = /^(\s*)("(?:\\.|[^"\\])*")(: )(.*)$/.exec(text);
  if (keyMatch) {
    push(keyMatch[1]!);
    push(keyMatch[2]!, "key");
    push(keyMatch[3]!, "punctuation");
    pushStructuredValue(keyMatch[4]!, push);
    return segments;
  }

  const trimmedMatch = /^(\s*)(.*)$/.exec(text);
  if (trimmedMatch) {
    push(trimmedMatch[1]!);
    pushStructuredValue(trimmedMatch[2]!, push);
    return segments;
  }

  return [{ text }];
}

function pushStructuredValue(
  valueText: string,
  push: (chunk: string, role?: StyledSegment["role"]) => void,
): void {
  if (!valueText) return;
  const trailingComma = valueText.endsWith(",");
  const core = trailingComma ? valueText.slice(0, -1) : valueText;

  if (core === MULTILINE_START || core === MULTILINE_END) {
    push(core, "delimiter");
  } else if (
    core === "{" ||
    core === "}" ||
    core === "[" ||
    core === "]" ||
    core === "{}" ||
    core === "[]"
  ) {
    push(core, "punctuation");
  } else if (core.startsWith('"') && core.endsWith('"') && core.length >= 2) {
    push(core, "string");
  } else if (
    core === "true" ||
    core === "false" ||
    core === "null" ||
    core === "undefined"
  ) {
    push(core, "keyword");
  } else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?n?$/.test(core)) {
    push(core, "number");
  } else {
    push(core);
  }

  if (trailingComma) {
    push(",", "punctuation");
  }
}

function renderStyledLine(
  line: WrappedLine,
  lineMatches: readonly SearchMatch[],
  activeMatch: SearchMatch | undefined,
  theme: Theme,
): string {
  const segments = tokenizeLine(line);
  if (segments.length === 0) return "";

  if (lineMatches.length === 0) {
    return segments
      .map((segment) => styleSegment(segment.text, segment.role, theme))
      .join("");
  }

  let output = "";
  let offset = 0;

  for (const segment of segments) {
    const segStart = offset;
    const segEnd = offset + segment.text.length;
    offset = segEnd;

    let cursor = segStart;
    for (const match of lineMatches) {
      if (match.end <= cursor) continue;
      if (match.start >= segEnd) break;

      const hitStart = Math.max(cursor, match.start);
      const hitEnd = Math.min(segEnd, match.end);
      if (hitStart > cursor) {
        output += styleSegment(
          segment.text.slice(cursor - segStart, hitStart - segStart),
          segment.role,
          theme,
        );
      }

      const matchedText = segment.text.slice(
        hitStart - segStart,
        hitEnd - segStart,
      );
      const isActive =
        activeMatch !== undefined &&
        activeMatch.lineIndex === match.lineIndex &&
        activeMatch.start === match.start &&
        activeMatch.end === match.end;
      output += isActive
        ? theme.style(matchedText, {
            fg: theme.colors.searchMatchBg,
            bg: theme.colors.searchMatchText,
            bold: true,
          })
        : theme.style(matchedText, {
            fg: "searchMatchText",
            bg: "searchMatchBg",
          });
      cursor = hitEnd;
    }

    if (cursor < segEnd) {
      output += styleSegment(
        segment.text.slice(cursor - segStart),
        segment.role,
        theme,
      );
    }
  }

  return output;
}

function styleSegment(
  text: string,
  role: StyledSegment["role"],
  theme: Theme,
): string {
  switch (role) {
    case "heading":
      return theme.fg("mdHeading", theme.bold(text));
    case "rule":
      return theme.fg("mdHr", text);
    case "delimiter":
      return theme.fg("dim", text);
    case "key":
      return theme.fg("syntaxVariable", text);
    case "string":
      return theme.fg("syntaxString", text);
    case "number":
      return theme.fg("syntaxNumber", text);
    case "keyword":
      return theme.fg("syntaxKeyword", text);
    case "punctuation":
      return theme.fg("syntaxPunctuation", text);
    default:
      return text;
  }
}

interface ScrollbarState {
  visible: boolean;
  thumbTop: number;
  thumbHeight: number;
}

function computeScrollbar(
  totalLines: number,
  viewportHeight: number,
  scrollOffset: number,
): ScrollbarState {
  if (totalLines <= viewportHeight || viewportHeight <= 0) {
    return { visible: false, thumbTop: 0, thumbHeight: 0 };
  }
  const thumbHeight = Math.max(
    1,
    Math.round((viewportHeight / totalLines) * viewportHeight),
  );
  const maxScroll = Math.max(1, totalLines - viewportHeight);
  const maxThumbTop = Math.max(0, viewportHeight - thumbHeight);
  const thumbTop = Math.round((scrollOffset / maxScroll) * maxThumbTop);
  return { visible: true, thumbTop, thumbHeight };
}

function renderScrollbarCell(
  scrollbar: ScrollbarState,
  rowOffset: number,
  theme: Theme,
): string {
  if (!scrollbar.visible) return theme.fg("border", "│");
  const isThumb =
    rowOffset >= scrollbar.thumbTop &&
    rowOffset < scrollbar.thumbTop + scrollbar.thumbHeight;
  return isThumb
    ? theme.fg("scrollbarThumb", "┃")
    : theme.fg("scrollbarTrack", "│");
}

function joinLeftRight(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 <= width) {
    return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  }
  return truncateToWidth(`${left} ${right}`, width, "", true);
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
