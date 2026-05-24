# Run This in OMP to Verify All Tools

Copy-paste each block into your OMP session, then screenshot the results.

## Step 1: Open a session
```
tui_open { command: "cmd.exe", cols: 80, rows: 24 }
```
**Screenshot this** - should show:
```
── ✓ tui_open · cmd.exe [80×24] (450ms) ──
  Session: tui-xxx
──
```

## Step 2: Interact
```
tui_interact { keys: ["echo hello", "enter"] }
```
**Screenshot this** - should show green ✓, blue "tui_interact", gray metadata

## Step 3: List sessions
```
tui_list {}
```
**Screenshot this** - should show session list in card format

## Step 4: Close
```
tui_close {}
```
**Screenshot this** - should show clean close card

## What to Check

1. ✓ Green checkmark for success
2. ✗ Red X for errors (try `tui_close { id: "nonexistent" }`)
3. Tool name in **blue/accent** color
4. `──` rules at top and bottom
5. Content indented with 2 spaces
6. No `┌┐└┘│├┤` box-drawing characters

## Share Screenshots

Reply with the screenshots and I'll verify each matches OMP's native design.
