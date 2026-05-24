# PTY Session Renderer Verification

## Steps

1. Reload OMP: `/reload-plugins`
2. Run each tool call below and screenshot the result

### Tool Sequence

```
1. tui_open: Start cmd.exe session
   tui_open { command: "cmd.exe", cols: 80, rows: 24 }

2. tui_interact: Send echo command
   tui_interact { keys: ["echo hello world", "enter"] }

3. tui_capture: Capture settled screen
   tui_capture {}

4. tui_probe: Discover focusables
   tui_probe { max_tabs: 5 }

5. tui_resize: Resize terminal
   tui_resize { cols: 100, rows: 30 }

6. tui_exec: Run async command
   tui_exec { command: "dir" }

7. tui_output: Read accumulated output
   tui_output { wait_ms: 1000 }

8. tui_screenshot: ANSI screenshot
   tui_screenshot {}

9. tui_wait: Wait for pattern
   tui_wait { pattern: ">", timeout_ms: 5000 }

10. tui_list: List active sessions
    tui_list {}

11. tui_session: Get session state
    tui_session {}

12. tui_send_raw: Send escape sequence
    tui_send_raw { data: "\x1b[c" }

13. tui_close: Close session
    tui_close {}
```

## Design Checklist

Each screenshot should show:
- [ ] Horizontal rules `──` at top and bottom of tool cards
- [ ] Tool name in accent color (blue/cyan)
- [ ] Checkmark `✓` in green for success
- [ ] Error `✗` in red for failures  
- [ ] Content indented with 2 spaces
- [ ] Metadata in muted gray
- [ ] Duration in parentheses when applicable
- [ ] Clean separation between cards

## Expected Style

```
── ✓ tui_open · cmd.exe [80×24] (450ms) ──
  Session: tui-abc123
──
```

Compare against OMP native tools:
- `bash`: `── ✓ bash · echo hello ──`
- `read`: `── ✓ read · src/main.ts ──`
- `eval`: `── ✓ [1/2] pandas describe · (838ms) ──`
