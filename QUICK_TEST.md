# Quick Test — 30 seconds

## Step 1: Reload
Type in OMP chat:
```
/reload-plugins
```

## Step 2: Open session
```
tui_open { command: "cmd.exe" }
```

## Step 3: Screenshot
Take a screenshot of the **card** that appears after the command runs.

## What to Look For

✓ Card should show:
```
── ✓ tui_open · cmd.exe [100×30] (Xms) ──
  Session: tui-xxx
──
```

✓ Colors:
- `tui_open` in **blue** (accent)
- `✓` in **green** (success)
- `──` in **gray** (muted)
- `cmd.exe` in **white** (fg)

✗ If you see:
- `┌─ │ └─` box-drawing = NOT updated, reload again
- Plain text without `──` = NOT updated, reload again

## Share Screenshot

Reply in chat with the screenshot.
