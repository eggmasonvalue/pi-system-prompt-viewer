/**
 * /system-context — inspect the request footprint exposed by Pi.
 *
 * The primary System Footprint is captured at agent_start, after Pi has
 * assembled the system prompt. Provider Request is captured at
 * before_provider_request, after Pi has converted the request for its provider.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  renderProviderNeutralContent,
  renderStructured,
  serializeProviderPayload,
  toProviderNeutralTool,
  type ProviderNeutralContent,
} from "../lib/footprint-model.ts";
import {
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ViewerMode = "system" | "provider";

type ProviderSnapshot = {
  displayText: string;
  copyText: string;
  label?: string;
  requestNumber: number;
  requestCount: number;
};

const CHROME_ROWS = 8;

export default function systemPromptViewer(pi: ExtensionAPI) {
  let providerRequestCount = 0;
  let latestProvider: ProviderSnapshot | undefined;
  let systemFootprint: ProviderNeutralContent | undefined;

  pi.on("agent_start", (_event, ctx) => {
    providerRequestCount = 0;
    latestProvider = undefined;
    systemFootprint = makeSystemFootprint(pi, ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const requestNumber = ++providerRequestCount;
    latestProvider = {
      displayText: renderStructured(event.payload),
      copyText: serializeProviderPayload(event.payload),
      label: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      requestNumber,
      requestCount: providerRequestCount,
    };
  });

  pi.registerCommand("system-context", {
    description: "Show the system footprint or latest provider payload",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "/system-context is available in interactive Pi only.",
          "warning",
        );
        return;
      }

      await ctx.waitForIdle();
      const footprint = systemFootprint ?? makeSystemFootprint(pi, ctx);
      const systemText = renderProviderNeutralContent(footprint);

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new RequestFootprintViewer(
            tui,
            theme,
            latestProvider,
            systemText,
            done,
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "95%",
            maxHeight: "92%",
            margin: 0,
          },
        },
      );
    },
  });
}

function makeSystemFootprint(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "getSystemPrompt">,
): ProviderNeutralContent {
  return {
    systemPrompt: ctx.getSystemPrompt(),
    tools: getProviderNeutralTools(pi),
  };
}

function getProviderNeutralTools(
  pi: ExtensionAPI,
): ReturnType<typeof toProviderNeutralTool>[] {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool: ToolInfo) => toProviderNeutralTool(tool));
}

class RequestFootprintViewer {
  private mode: ViewerMode = "system";
  private scrollOffset = 0;
  private copiedAt = 0;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private totalDisplayLines = 0;
  private readonly systemText: string;
  private readonly providerDisplayText: string;
  private readonly providerCopyText: string;
  private readonly provider?: ProviderSnapshot;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    provider: ProviderSnapshot | undefined,
    systemText: string,
    private readonly done: () => void,
  ) {
    this.provider = provider;
    this.systemText = systemText;
    this.providerDisplayText =
      provider?.displayText ??
      [
        "No before_provider_request payload was captured for this run.",
        "",
        "Use the System Footprint view for the captured semantic system context.",
      ].join("\n");
    this.providerCopyText = provider?.copyText ?? this.providerDisplayText;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "tab") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      this.mode = this.mode === "system" ? "provider" : "system";
      this.scrollOffset = 0;
    } else {
      const visible = this.visibleLineCount();
      const maximumOffset = Math.max(0, this.totalDisplayLines - visible);

      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
        this.scrollOffset = Math.min(maximumOffset, this.scrollOffset + 1);
      } else if (matchesKey(data, "pageUp")) {
        this.scrollOffset = Math.max(0, this.scrollOffset - visible);
      } else if (matchesKey(data, "pageDown")) {
        this.scrollOffset = Math.min(
          maximumOffset,
          this.scrollOffset + visible,
        );
      } else if (matchesKey(data, "home")) {
        this.scrollOffset = 0;
      } else if (matchesKey(data, "end")) {
        this.scrollOffset = maximumOffset;
      } else if (matchesKey(data, "c")) {
        this.copyActiveView();
      } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        this.dispose();
        this.done();
        return;
      } else {
        return;
      }
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const contentWidth = Math.max(1, innerWidth - 1);
    const displayLines = this.buildDisplayLines(contentWidth);
    const visible = this.visibleLineCount();
    this.totalDisplayLines = displayLines.length;
    this.scrollOffset = Math.min(
      this.scrollOffset,
      Math.max(0, displayLines.length - visible),
    );

    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string) =>
      `${border("│")}${pad(content, innerWidth)}${border("│")}`;
    const title =
      this.mode === "system"
        ? "Provider-neutral System Footprint"
        : "Provider Request";
    const tabs =
      this.mode === "system"
        ? `${this.theme.fg("accent", this.theme.bold("System Footprint"))}  ${this.theme.fg("dim", "Provider Request")}`
        : `${this.theme.fg("dim", "System Footprint")}  ${this.theme.fg("accent", this.theme.bold("Provider Request"))}`;
    const output = [border(`╭${"─".repeat(innerWidth)}╮`)];
    output.push(row(` ${this.theme.fg("accent", this.theme.bold(title))}`));
    output.push(row(` ${tabs}`));
    output.push(row(` ${this.theme.fg("dim", this.modeDescription())}`));
    output.push(row(""));

    const end = Math.min(this.scrollOffset + visible, displayLines.length);
    for (let index = this.scrollOffset; index < end; index++) {
      output.push(row(` ${displayLines[index]!}`));
    }
    for (let index = end - this.scrollOffset; index < visible; index++)
      output.push(row(""));

    const range = `${displayLines.length === 0 ? 0 : this.scrollOffset + 1}-${end}/${displayLines.length}`;
    const copied =
      Date.now() - this.copiedAt < 2_000
        ? this.theme.fg("success", "copied")
        : "copy";
    const footerLeft = this.theme.fg("dim", range);
    const footerRight = this.theme.fg(
      "dim",
      `Tab/←→ toggle  c ${copied}  ↑↓/jk pgup/pgdn home/end  Esc/q`,
    );
    const spacing = Math.max(
      1,
      innerWidth - 1 - visibleWidth(footerLeft) - visibleWidth(footerRight),
    );
    output.push(row(""));
    output.push(row(` ${footerLeft}${" ".repeat(spacing)}${footerRight}`));
    output.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return output;
  }

  invalidate(): void {}

  private visibleLineCount(): number {
    return Math.max(1, Math.floor(this.tui.terminal.rows * 0.92) - CHROME_ROWS);
  }

  private buildDisplayLines(width: number): string[] {
    const text =
      this.mode === "system" ? this.systemText : this.providerDisplayText;
    const displayLines: string[] = [];
    for (const line of text.split("\n")) {
      const wrapped = wrapTextWithAnsi(line, width);
      displayLines.push(...(wrapped.length ? wrapped : [""]));
    }
    return displayLines;
  }

  private modeDescription(): string {
    if (this.mode === "system") {
      return "Agent-start prompt + active semantic tools • c copies system footprint";
    }
    if (!this.provider) {
      return "No provider payload captured • c copies displayed text";
    }
    const request = `latest payload (${this.provider.requestNumber}/${this.provider.requestCount})`;
    const model = this.provider.label ? ` • ${this.provider.label}` : "";
    return `${request}${model} • display expands strings; c copies provider JSON • not byte-for-byte HTTP`;
  }

  private copyActiveView(): void {
    const text =
      this.mode === "system" ? this.systemText : this.providerCopyText;
    const base64 = Buffer.from(text, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    this.copiedAt = Date.now();
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.tui.requestRender(), 2_000);
  }

  dispose(): void {
    clearTimeout(this.copiedTimer);
    this.copiedTimer = undefined;
  }
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
