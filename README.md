# PTY Session for oh-my-pi

Persistent terminal session bridge that lets oh-my-pi interact with TUI applications (vim, lazygit, Textual, etc.) through a real xterm.js emulator with intelligent screen settlement detection.

## Install

```bash
cd pty-session
bun install
```

Then copy or symlink into your oh-my-pi extensions:

```bash
# User-scoped (available everywhere)
cp -r pty-session ~/.omp/agent/extensions/

# Or project-scoped
cp -r pty-session ./.omp/extensions/
```

Reload omp with `/reload-plugins` or restart.

## Tools

| Tool | Purpose |
|------|---------|
| `tui_open` | Start a TUI app in a persistent PTY |
| `tui_interact` | Send keystrokes and capture the settled screen |
| `tui_capture` | Capture current screen without sending input |
| `tui_probe` | Explore focusable elements by cycling Tab |
| `tui_resize` | Resize the terminal dimensions |
| `tui_send_raw` | Send raw bytes without settlement detection |
| `tui_close` | Kill a session |
| `tui_list` | List active sessions |
| `tui_exec` | Execute command in session, return immediately (async) |
| `tui_output` | Read accumulated output + scrollback from session |
| `tui_screenshot` | Visual screenshot with ANSI color codes |
| `tui_wait` | Wait for a text pattern to appear in output |

## Settlement Engine

The core problem with TUI automation is knowing **when the screen has finished redrawing** after input. This plugin combines four strategies:

### 1. Frame Diffing (Masked)

After sending input, the plugin samples the screen every 50ms. Each frame is hashed with animations masked out:
- Spinners (`⠋⠙⠹...`) → `{SPIN}`
- Progress bars (`█▓▒░`) → `{PROG}`
- Blinking cursor → `{CURSOR}`

When two consecutive masked hashes match, the screen is considered stable.

### 2. Content-Change Histogram

For apps with persistent localized animations (corner spinner, live clock), the plugin tracks a histogram of masked frames over the sampling window. If one frame appears >= 25% of the time, it wins — the rest of the screen is stable even if a small region keeps animating.

### 3. Hard Timeout

Every capture has a hard `settle_ms` ceiling (default 2000ms). The plugin always returns, never hangs. On timeout, it returns the most frequently observed frame from the histogram.

### 4. Two-Phase Settled Regions

The screen is decomposed into regions (panels, headers, sidebars, lists). Each region gets a `changeScore` comparing the current frame to the previous one. The output tells you which regions are stable and which are still animating.

## Usage Examples

### Open a Textual app

```
tui_open:0 {"command": "python my_textual_app.py", "id": "myapp", "cols": 120, "rows": 35}
```

Returns the screen with region analysis:
```
[Screen content]

**Capture**: frame-diff | 450ms | 10 samples | Stable: yes
**Cursor**: (24, 12)

**Regions**:
  [✓] header @(0,0) 120×1 | change:0%
      └─ My Textual App
  [✓] sidebar @(0,1) 20×33 | change:0%
  [✓] main @(20,1) 100×33 | change:0%
  [✗] status @(0,34) 120×1 | change:45%
      └─ Loading... {SPIN}

*Animated regions: status@(0,34)*
```

### Navigate and interact

```
tui_interact:1 {"id": "myapp", "keys": ["tab", "tab", "enter"]}
```

### Probe focusable elements

```
tui_probe:2 {"id": "myapp"}
```

Returns:
```
**Focusable Elements** (4 found):

Tab 0: sidebar @ (0,1) (cursor 2,3)
  └─ "Dashboard"
Tab 1: button @ (45,18) (cursor 47,18)
  └─ "[ Submit ]"
Tab 2: input @ (45,12) (cursor 45,12)
  └─ "Name: ______"
Tab 3: sidebar @ (0,1) (cursor 2,5)
  └─ "Settings"
```

### Vim workflow

```
tui_open:3 {"command": "vim src/main.rs", "id": "vim"}
tui_interact:4 {"id": "vim", "keys": [":", "w", "q", "enter"]}
tui_close:5 {"id": "vim"}
```

### Resize for responsive layouts

```
tui_resize:6 {"id": "myapp", "cols": 80, "rows": 24}
```

## Named Keys Reference

| Key | Sent |
|-----|------|
| `enter`, `escape`, `tab`, `backspace`, `space` | obvious |
| `up`, `down`, `left`, `right` | arrow keys |
| `home`, `end`, `pageup`, `pagedown` | navigation |
| `delete`, `insert` | edit keys |
| `ctrl_a` ... `ctrl_z` | control sequences |
| `f1` ... `f12` | function keys |

Any string not in the key map is typed literally. To send a literal `tab`, use `\t` via `tui_send_raw`.

## How It Works

1. **node-pty** spawns the real OS process with a pseudo-terminal
2. **xterm-headless** receives every byte from the PTY and maintains correct terminal state (cursor, colors, alternate buffer, scroll regions)
3. The plugin reads the xterm buffer cell-by-cell to reconstruct the visible screen
4. Region detection traces box-drawing characters to find panels, then classifies them by position and content
5. The settlement engine decides when the screen is "done" and returns the capture

## Limitations

- **Mouse events**: Not directly supported. Most TUIs work fine with keyboard navigation.
- **24-bit color**: Captured in ANSI mode but may not perfectly round-trip.
- **Sixel/inline images**: Not supported; xterm.js headless does not decode image protocols.
- **Process orphaning**: If omp crashes, PTY processes may survive. The plugin cleans up on `session_shutdown`.

## Troubleshooting

**Screen never settles?**
Use `tui_capture` with `immediate: true` to bypass settlement, or increase `settle_ms` to 5000.

**Colors lost?**
Set `include_ansi: true` on any capture tool.

**App says "terminal too small"?**
Increase `cols` and `rows` in `tui_open` (default is 100×30).

**Focus probe finds nothing?**
Some apps don't use standard Tab focus. Try sending arrow keys instead.

## Testing

The extension includes a comprehensive testing system in two modes:

### Non-Interactive Tests (`test-harness.ts`)

Tests all tools directly via mock ExtensionAPI — no LLM required. Covers:

- **15 tests**: all 8 tools, temp-dir loading fallback, rendering fidelity (cursor position, screen stability, echo output), arrow key recall
- **Run**: `bun run test-harness.ts` (requires bun, runs on the machine)

```bash
bun run test-harness.ts
```

### Interactive Tests (`test-interactive.ts`)

End-to-end tests using OMP's built-in MockModel — simulates LLM tool calls without real LLM costs. Covers:

- **8 tests**: full tool pipeline (open→interact→list→capture→close), screen stability, invalid command error handling, invalid session close error handling
- **Run**: `bun run test-interactive.ts`

```bash
bun run test-interactive.ts
```

Both suites are self-contained and clean up after themselves (temp sessions, PTY processes).

### Architecture

```
test-harness.ts   →  Direct tool.execute() calls (no model dispatch)
test-interactive.ts → MockModel → Agent → AgentSession → prompt → tool execution
```

The interactive path exercises the full OMP agent pipeline: model → stream → tool_call → tool execution → tool_result → validation. This matches how `bun test` in OMP's own test suite tests extensions.
