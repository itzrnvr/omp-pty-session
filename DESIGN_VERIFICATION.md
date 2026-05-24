# PTY Session Design Verification Guide

## What You Need To Do

1. Run `/reload-plugins` in OMP
2. Execute each tool below
3. Screenshot the result card in the conversation TUI
4. Compare against the reference patterns

## Expected Output Format

Each tool should render as a **card** with:
- `──` horizontal rule at top
- Checkmark `✓` (green) or error `✗` (red)
- Tool name in **accent color** (blue/cyan)
- Description in normal color
- Duration in muted gray `(450ms)`
- Content indented with 2 spaces
- `──` horizontal rule at bottom

## Tool Sequence to Test

### 1. tui_open
```
tui_open { command: "cmd.exe", cols: 80, rows: 24 }
```
**Expected card:**
```
── ✓ tui_open · cmd.exe [80×24] (450ms) ──
  Session: tui-abc123
──
```

### 2. tui_interact
```
tui_interact { keys: ["echo hello world", "enter"] }
```
**Expected card:**
```
── ✓ tui_interact · 2 keys sent (1200ms) ──
  Strategy: frame-diff
──
```

### 3. tui_capture
```
tui_capture {}
```
**Expected card:**
```
── ✓ tui_capture · tui-abc123 (80ms) ──
  Screen captured
──
```

### 4. tui_probe
```
tui_probe { max_tabs: 5 }
```
**Expected card:**
```
── ✓ tui_probe · 2 focusable elements (300ms) ──
  ├─ [1] row 5, col 10
  └─ [2] row 8, col 20
──
```

### 5. tui_resize
```
tui_resize { cols: 100, rows: 30 }
```
**Expected card:**
```
── ✓ tui_resize · tui-abc123 (50ms) ──
  Resized to 100×30
──
```

### 6. tui_send_raw
```
tui_send_raw { data: "\x1b[c" }
```
**Expected card:**
```
── ✓ tui_send_raw · tui-abc123 (20ms) ──
  Raw data sent
──
```

### 7. tui_exec
```
tui_exec { command: "dir" }
```
**Expected card:**
```
── ✓ tui_exec · dir (200ms) ──
  Command submitted
──
```

### 8. tui_output
```
tui_output { wait_ms: 1000 }
```
**Expected card:**
```
── ✓ tui_output · tui-abc123 (1000ms) ──
  Screen: captured · Scrollback: 50 lines
──
```

### 9. tui_screenshot
```
tui_screenshot {}
```
**Expected card:**
```
── ✓ tui_screenshot · tui-abc123 (150ms) ──
  ANSI screenshot saved
──
```

### 10. tui_wait
```
tui_wait { pattern: ">", timeout_ms: 5000 }
```
**Expected card:**
```
── ✓ tui_wait · pattern found (1200ms) ──
  Pattern: ">"
  Waited: 1200ms
──
```

### 11. tui_list
```
tui_list {}
```
**Expected card:**
```
── ✓ tui_list · 1 active session (30ms) ──
  [1] tui-abc123 · cmd.exe · 80×24
──
```

### 12. tui_session
```
tui_session {}
```
**Expected card:**
```
── ✓ tui_session · 1 session (30ms) ──
  [1] tui-abc123 · cmd.exe · 80×24
── Current: tui-abc123
```

### 13. tui_close
```
tui_close {}
```
**Expected card:**
```
── ✓ tui_close · tui-abc123 (100ms) ──
  Session closed
──
```

## Design Checklist

For each screenshot, verify:

- [ ] Card has `──` at top and bottom
- [ ] Tool name is colored (accent/blue)
- [ ] Checkmark `✓` is green
- [ ] Error `✗` is red (test with bad session ID)
- [ ] Duration is in gray `(450ms)`
- [ ] Content is indented with 2 spaces
- [ ] No box-drawing characters (`┌┐└┘│├┤`)
- [ ] Clean separation between cards

## Reference: OMP Native Style

From eval.webp:
```
── ✓ [1/2] pandas describe · (838ms) ──
  import pandas as pd
  records = [{"id": n, "name": f"u{n}", "score": n * 7} for n in range(1, 6)]
── Output ──
  count  id  score
  mean   3.0 21.0
  ...
──
```

From lsp.webp:
```
── ✓ LSP references ──
  src/format.ts
  line 1
── Response ──
  ✓ 5 found (Ctrl+O for more)
  ├─ src/format.ts 1 reference
  │  └─ line 1, col 17
  ...
──
```

## If Design Doesn't Match

Screenshot the actual output and share it. I'll adjust the renderers.
