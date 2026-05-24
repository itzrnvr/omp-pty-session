# pty-session

Persistent terminal session extension for Oh My Pi. Gives the coding agent full interactive CLI capabilities — open shells, drive TUI applications, run background jobs, wait for output patterns, and take visual screenshots. 13 tools, all tested with mock LLM (zero cost).

## Quick Start

```bash
# Install in OMP extensions
cp -r pty-session ~/.omp/agent/extensions/
cd ~/.omp/agent/extensions/pty-session && bun install

# Reload OMP (/reload-plugins or restart)
```

## How It Works

```
Agent (OMP/Bun)
  │
  │  pi.registerTool("tui_open", ...)
  │  pi.registerTool("tui_interact", ...)
  │  ...
  │
  ▼
pty-session extension (index.ts)
  │
  │  JSON-RPC over stdin/stdout
  │
  ▼
pty-server.js (Node.js subprocess)
  │
  ├── node-pty (winpty on Windows) → real OS pseudo-terminal
  │     └── cmd.exe, vim, ssh, htop, python, any CLI/TUI
  │
  ├── xterm-headless (terminal emulator)
  │     └── maintains correct screen state, cursor, colors, scrollback
  │
  ├── Settlement Engine
  │     ├── Frame diffing (masked: spinners, progress bars, cursors)
  │     ├── Content-change histogram (persistent animations)
  │     └── Hard timeout (never hangs)
  │
  └── Scrollback buffer (5000 lines)
        └── readable via tui_output with offset/limit
```

**Why a subprocess?** Bun v1.3.14 has broken conpty pipe handling on Windows. The extension spawns a Node.js child process (`pty-server.js`) that owns all PTY instances. Communication is newline-delimited JSON-RPC over stdin/stdout. This isolates node-pty from Bun's I/O layer entirely.

## Tools (13)

| Tool | What it does |
|---|---|
| `tui_open` | Start a persistent terminal session (shell, TUI, SSH) |
| `tui_interact` | Send keystrokes, capture settled screen |
| `tui_capture` | Capture screen without interaction |
| `tui_probe` | Discover focusable elements via Tab cycling |
| `tui_resize` | Resize terminal dimensions |
| `tui_send_raw` | Send raw bytes/escape sequences |
| `tui_list` | List active sessions with metadata |
| `tui_session` | Unified session state + current default |
| `tui_close` | Kill a session |
| `tui_exec` | Execute command, return immediately (async) |
| `tui_output` | Read screen + scrollback (5000 lines) |
| `tui_screenshot` | Visual capture with ANSI color codes |
| `tui_wait` | Poll until pattern appears on screen |

## Named Keys Reference

| Key | Sent |
|---|---|
| `enter`, `escape`, `tab`, `backspace`, `space` | obvious |
| `up`, `down`, `left`, `right` | arrow keys |
| `home`, `end`, `pageup`, `pagedown` | navigation |
| `delete`, `insert` | edit keys |
| `ctrl_a` ... `ctrl_z` | control sequences |
| `f1` ... `f12` | function keys |
| `left_parenthesis`, `right_parenthesis` | `(` `)` |
| `left_brace`, `right_brace` | `{` `}` |
| `left_bracket`, `right_bracket` | `[` `]` |
| `pipe`, `backslash`, `slash` | `\|` `\` `/` |
| `colon`, `semicolon` | `:` `;` |
| `single_quote`, `double_quote` | `'` `"` |
| `plus`, `minus`, `equals` | `+` `-` `=` |
| `comma`, `period` | `,` `.` |
| And more — any unrecognized string is typed literally | |

## Settlement Engine

The core problem with TUI automation is knowing **when the screen has finished redrawing** after input. Four strategies combine:

1. **Frame Diffing (Masked)** — samples screen every 50ms, hashes with animations masked (spinners→`{SPIN}`, progress bars→`{PROG}`, cursor→`{CURSOR}`). Two consecutive matching hashes = stable.
2. **Content-Change Histogram** — for persistent localized animations (corner spinner, live clock), tracks histogram of masked frames. If one frame appears ≥25% of the time, it wins.
3. **Hard Timeout** — every capture has a `settle_ms` ceiling (default 2000ms). Never hangs.
4. **Two-Phase Settled Regions** — screen decomposed into regions (panels, headers, sidebars). Each region gets a `changeScore`; output tells you which are stable and which are animating.

## Testing

The extension includes a comprehensive testing system in two modes, using the shared [omp-test-harness](https://github.com/itzrnvr/omp-test-harness).

### Non-Interactive (`test-harness.ts`) — 22 tests

Tests all tools directly via mock ExtensionAPI — no LLM required.

```bash
bun run test-harness.ts
```

Covers: all 13 tools, temp-dir loading fallback, rendering fidelity (cursor position, screen stability, ANSI output), special-character keys, background job pattern, pattern waiting.

### Interactive (`test-interactive.ts`) — 12 tests

End-to-end tests using OMP's built-in MockModel — simulates LLM tool calls without real LLM costs.

```bash
bun run test-interactive.ts
```

Covers: full tool pipeline (open→interact→list→capture→close), screen stability, invalid command errors, invalid session close errors, exec+output pattern, screenshot capture, wait pattern.

## Usage Examples

### Open a shell and run commands

```
tui_open { command: "cmd.exe", cols: 120, rows: 35 }
tui_exec { command: "echo Hello World" }
tui_output { wait_ms: 500 }
```

### Drive a TUI application

```
tui_open { command: "vim file.txt", cols: 80, rows: 24 }
tui_interact { keys: [":", "w", "q", "enter"] }
tui_close {}
```

### SSH session

```
tui_open { command: "ssh user@host", cols: 120, rows: 35 }
tui_wait { pattern: "password:" }
tui_interact { keys: ["mypassword", "enter"] }
tui_wait { pattern: "$" }  # wait for shell prompt
tui_exec { command: "ls -la" }
tui_output { wait_ms: 500 }
```

### Background jobs

```
tui_open { command: "cmd.exe" }
tui_exec { command: "npm run build" }        # returns immediately
tui_wait { pattern: "Build complete", timeout_ms: 60000 }  # wait for it
tui_output { wait_ms: 0 }                    # read all output
```

### Visual screenshot

```
tui_screenshot { include_ansi: true }  # returns colored terminal capture
```

### Probe TUI layout

```
tui_open { command: "python my_textual_app.py" }
tui_probe { max_tabs: 10 }  # discovers all focusable elements
```

## Troubleshooting

**Screen never settles?** Use `tui_capture` with `immediate: true` to bypass settlement, or increase `settle_ms` to 5000.

**Colors lost?** Set `include_ansi: true` on any capture tool, or use `tui_screenshot` (defaults to ansi).

**App says "terminal too small"?** Increase `cols` and `rows` in `tui_open` (default is 100×30).

**Focus probe finds nothing?** Some apps don't use standard Tab focus. Try sending arrow keys instead.

**Short-lived commands show blank screen?** Commands that exit immediately (like `omp --version`) clear the PTY before capture. Open a persistent shell first: `tui_open { command: "cmd.exe" }` then `tui_exec { command: "omp --version" }`.

**Bare command names fail on Windows?** The extension pre-resolves bare names via `where.exe` and merges `~/.bun/bin` into the PATH. If a command still isn't found, use the full path or `cmd.exe /c command`.

## Limitations

- **Mouse events**: Not directly supported. Most TUIs work fine with keyboard navigation.
- **24-bit color**: Captured in ANSI mode but may not perfectly round-trip.
- **Sixel/inline images**: Not supported; xterm.js headless does not decode image protocols.
- **Process orphaning**: If OMP crashes, PTY processes may survive. The plugin cleans up on `session_shutdown`.
