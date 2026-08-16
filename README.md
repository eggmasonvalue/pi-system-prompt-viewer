# pi-system-prompt-viewer

Display the assembled [Pi](https://pi.dev) system prompt and active tool schemas in a scrollable overlay.

The command snapshots the prompt on `agent_start`, after other extensions have rewritten it. Opening it before the first agent run shows the base prompt.

## Usage

```
/system-prompt
```

| Key | Action |
|-----|--------|
| `↑↓` / `j` `k` | Scroll line |
| `PgUp` / `PgDn` | Scroll page |
| `Home` / `End` | Jump to top/bottom |
| `c` | Copy overlay text to clipboard |
| `Esc` / `q` | Close |

## Install

```bash
pi install npm:pi-system-prompt-viewer
```

Or via git:

```bash
pi install git:github.com/eggmasonvalue/pi-system-prompt-viewer
```

Then restart Pi or run `/reload`.

## License

Apache-2.0
