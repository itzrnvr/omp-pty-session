import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn as spawnChild, type ChildProcess } from "child_process";
import * as path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

// =============================================================================
// PTY Session Manager
// =============================================================================
// pty-session spawns a Node.js subprocess (pty-server.js) that owns all
// node-pty instances. Communication is via newline-delimited JSON-RPC over
// stdin/stdout. This avoids Bun's broken conpty pipe handling on Windows.

let serverProc: ChildProcess | null = null;
let requestId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let lastSessionId = "";
let serverBuffer = "";

function startServer(): ChildProcess {
  if (serverProc && !serverProc.killed) return serverProc;

  // Resolve pty-server.js: try local (dev/test), then known extension dir (OMP runtime)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  let serverPath = path.join(__dirname, "pty-server.js");
  if (!existsSync(serverPath)) {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    serverPath = path.join(home, ".omp/agent/extensions/pty-session/pty-server.js");
  }
  serverProc = spawnChild("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });

  serverBuffer = "";

  serverProc.stdout!.on("data", (chunk: Buffer) => {
    serverBuffer += chunk.toString();
    const lines = serverBuffer.split("\n");
    serverBuffer = lines.pop()!; // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ready) continue; // initial handshake
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch {}
    }
  });

  serverProc.stderr!.on("data", () => {
    // Suppress node-pty internal noise
  });

  serverProc.on("exit", () => {
    // Reject all pending requests
    for (const [, { reject }] of pending) {
      reject(new Error("PTY server exited"));
    }
    pending.clear();
    serverProc = null;
  });

  return serverProc;
}

async function call(method: string, params: Record<string, any> = {}): Promise<any> {
  const proc = startServer();
  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });

    const msg = JSON.stringify({ id, method, params }) + "\n";
    try {
      proc.stdin!.write(msg);
    } catch (e: any) {
      pending.delete(id);
      reject(new Error(`Failed to write to PTY server: ${e.message}`));
    }

    // Timeout after 30s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`PTY server timeout for ${method}`));
      }
    }, 30000);
  });
}

// ── Render helpers ──
// Inline visual indicators shown in the OMP conversation TUI when tools are invoked.
// These render as pi-tui Components (render(width): string[]).

function screenPreview(text: string, maxLines: number, width: number, theme: any): string[] {
  if (!text) return [theme.fg("muted", "  (empty)")];
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines);
  const out = shown.map(l => theme.fg("muted", "│ ") + l.substring(0, width - 4));
  if (lines.length > maxLines) {
    out.push(theme.fg("muted", `└─ ${lines.length - maxLines} more lines...`));
  }
  return out;
}

function renderComp(lines: string[]) {
  return { render: (_width: number) => lines };
}
// =============================================================================
// Extension Factory
// =============================================================================

export default function ptySession(pi: ExtensionAPI) {
  pi.setLabel("PTY Session");

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    if (serverProc && !serverProc.killed) {
      try {
        serverProc.kill();
      } catch {}
      serverProc = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_open
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_open",
    label: "Open TUI",
    description: "Start a persistent terminal session (shell, TUI app, SSH). The session survives across tool calls — open once, use many times. Returns the settled screen after startup. For commands that produce output and exit (like `omp --version`), open a shell first then use tui_exec: `tui_open { command: 'cmd.exe' }` then `tui_exec { command: 'omp --version' }`. For long-running TUIs (vim, htop, ssh), open directly. Sessions auto-close on extension shutdown.",
    parameters: z.object({
      command: z.string().describe("Command to run, e.g. 'vim file.txt' or 'python app.py'"),
      id: z.string().optional().describe("Optional session identifier. Auto-generated if omitted."),
      cwd: z.string().optional().describe("Working directory. Defaults to current session cwd."),
      cols: z.number().default(100).describe("Terminal width in columns"),
      rows: z.number().default(30).describe("Terminal height in rows"),
      settle_ms: z.number().default(2000).describe("Maximum ms to wait for screen to settle"),
      include_ansi: z.boolean().default(false).describe("Include ANSI color codes in output"),
      args: z.array(z.string()).optional().describe("Arguments for the command. Auto-split from command if omitted."),
    }),

    async execute(_tcid, params, signal, _onUpdate, ctx) {
      const result = await call("open", {
        command: params.command,
        id: params.id,
        cwd: params.cwd ?? ctx?.cwd ?? process.cwd(),
        cols: params.cols,
        rows: params.rows,
        settle_ms: params.settle_ms,
        include_ansi: params.include_ansi,
        args: params.args,
      });
      if (!signal?.aborted && result.id) lastSessionId = result.id;
      if (signal?.aborted) {
        await call("close", { id: result.id, force: true });
        return { content: [{ type: "text", text: "Cancelled" }] };
      }

      return {
        content: [{ type: "text", text: result.formatted }],
        details: { id: result.id, pid: result.pid, command: result.command, cwd: result.cwd, cols: result.cols, rows: result.rows },
      };
    },
    renderCall(args: any, theme: any) {
      const cmd = args.command || "?";
      const dims = `${args.cols ?? 100}×${args.rows ?? 30}`;
      return renderComp([
        theme.fg("muted", "┌─ Opening terminal ") + theme.fg("accent", cmd) + theme.fg("muted", " [" + dims + "]"),
        theme.fg("muted", "└─ ⠋ settling..."),
      ]);
    },
    renderResult(result: any, options: any, theme: any) {
      const id = result?.details?.id || "?";
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/```\n([\s\S]*?)```/)?.[1] || "";
      const dur = result?.details?.waitedMs ? `${result.details.waitedMs}ms` : "";
      const lines = screenPreview(screenText, 5, 80, theme);
      return renderComp([
        theme.fg("muted", "┌─ Session ") + theme.fg("success", id) + theme.fg("muted", ` · ${result?.details?.command || "?"} · ${dur}`),
        ...lines,
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_interact
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_interact",
    label: "Interact with TUI",
    description: "Send keystrokes to a TUI session and return the settled screen. Keystrokes are batched atomically then screen is captured after settlement. Named modifier keys: enter, escape, tab, backspace, space, up, down, left, right, home, end, pageup, pagedown, delete, insert, ctrl_a..ctrl_z, f1-f12. Special characters: left_parenthesis→(, right_parenthesis→), left_brace→{, right_brace→}, left_bracket→[, right_bracket→], pipe→|, backslash→\\, colon→:, semicolon→;, single_quote→', double_quote→\", plus→+, minus→-, and more. Any unrecognized string is typed literally. Common patterns: ['ctrl_c'] to interrupt, ['up','enter'] to recall last command, [':','w','q','enter'] for vim save+quit. For raw bytes/escape sequences use tui_send_raw.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID from tui_open (defaults to last opened)"),
      keys: z.array(z.string()).describe(
        "Keys to send as array of strings. Named modifier keys: enter, escape, tab, backspace, space, up, down, left, right, home, end, pageup, pagedown, delete, insert, ctrl_a..ctrl_z, f1-f12. Special chars use underscore names: left_parenthesis, right_parenthesis, left_brace, right_brace, pipe, backslash, colon, semicolon, single_quote, double_quote, plus, minus, etc. Unrecognized strings are typed literally."),
      settle_ms: z.number().default(2000).describe("Maximum ms to wait for screen to settle after input"),
      include_ansi: z.boolean().default(false).describe("Include ANSI color codes in output"),
    }),
    async execute(_tcid, params, signal, _onUpdate, _ctx) {
      const result = await call("interact", {
        id: params.id || lastSessionId,
        keys: params.keys,
        settle_ms: params.settle_ms,
        include_ansi: params.include_ansi,
      });

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled after input" }] };
      }

      return {
        content: [{ type: "text", text: result.formatted }],
        details: { id: params.id, strategy: result.strategy, waitedMs: result.waitedMs, samples: result.samples, isStable: result.isStable },
      };
    },
    renderCall(args: any, theme: any) {
      const keys = (args.keys || []).slice(0, 8);
      const more = (args.keys || []).length > 8 ? ` +${args.keys.length - 8} more` : "";
      const keyList = keys.map((k: string) => {
        const icon = k === "space" ? "␣" : k === "enter" ? "↵" : k === "tab" ? "⇥" : k === "escape" ? "⎋" : k === "backspace" ? "⌫" : k.startsWith("ctrl_") ? "^" + k.slice(5) : k.length > 8 ? k.slice(0,7)+"…" : k;
        return theme.fg("muted", "│  ") + icon;
      }).join("\n");
      return renderComp([
        theme.fg("muted", "┌─ Sending to ") + theme.fg("accent", args.id || "default") + (more ? theme.fg("muted", more) : ""),
        keyList,
        theme.fg("muted", "└─ ⠋ settling..."),
      ]);
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/```\n([\s\S]*?)```/)?.[1] || "";
      const strategy = result?.details?.strategy || "";
      const stable = result?.details?.isStable ? theme.fg("success", "Stable ✓") : theme.fg("warning", "Unstable");
      const lines = screenPreview(screenText, 6, 80, theme);
      return renderComp([
        theme.fg("muted", `┌─ tui-interact · ${strategy} · `) + stable,
        ...lines,
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_capture
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_capture",
    label: "Capture TUI Screen",
    description: "Capture the current screen of a TUI session without sending input. Use this to check state, verify output, or take a snapshot during long-running operations. For visual/color output use tui_screenshot instead. Set immediate:true to skip settlement (fast but may show mid-render).",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      settle_ms: z.number().default(1000).describe("Maximum ms to wait for settlement"),
      include_ansi: z.boolean().default(false).describe("Include ANSI color codes"),
      immediate: z.boolean().default(false).describe("Capture immediately without waiting for settlement"),
    }),
    async execute(_tcid, params, signal, _onUpdate, _ctx) {
      const result = await call("capture", {
        id: params.id || lastSessionId,
        settle_ms: params.settle_ms,
        include_ansi: params.include_ansi,
        immediate: params.immediate,
      });

      return { content: [{ type: "text", text: result.formatted }] };
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/```\n([\s\S]*?)```/)?.[1] || "";
      const lines = screenPreview(screenText, 6, 80, theme);
      return renderComp([
        theme.fg("muted", "┌─ Capture"),
        ...lines,
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_probe
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_probe",
    label: "Probe TUI Focus",
    description: "Discover interactive elements in a TUI by cycling Tab and tracking cursor changes. Returns a list of focusable positions with screen context at each stop. Stops when the cursor returns to a previously-seen position (cycle detected). Use this to map out a TUI's tab order before interacting.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      max_tabs: z.number().default(20).describe("Maximum Tab presses before stopping"),
      settle_ms: z.number().default(800).describe("Settlement wait per Tab"),
    }),
    async execute(_tcid, params, signal, _onUpdate, _ctx) {
      const focusables: { tabIndex: number; cursorX: number; cursorY: number; screen: string }[] = [];
      const seenHashes = new Set<string>();

      for (let i = 0; i < params.max_tabs; i++) {
        const result = await call("interact", {
          id: params.id || lastSessionId,
          keys: ["tab"],
          settle_ms: params.settle_ms,
        });

        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled during probe" }] };
        }

        const hash = `${result.cursorX}-${result.cursorY}`;
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          focusables.push({
            tabIndex: i,
            cursorX: result.cursorX,
            cursorY: result.cursorY,
            screen: result.text,
          });
        } else {
          break; // cycle detected
        }
      }

      let out = `**Focusable Elements** (${focusables.length} found):\n\n`;
      for (const f of focusables) {
        out += `Tab ${f.tabIndex}: cursor (${f.cursorX},${f.cursorY})\n`;
        const firstLine = f.screen.split("\n").find(l => l.trim());
        if (firstLine) out += `  └─ "${firstLine.trim().substring(0, 50)}"\n`;
      }

      return { content: [{ type: "text", text: out }], details: { focusables } };
    },
    renderCall(args: any, theme: any) {
      return renderComp([
        theme.fg("muted", `┌─ Probing focusables (max ${args.max_tabs ?? 20} tabs)`),
        theme.fg("muted", "└─ ⠋ cycling Tab..."),
      ]);
    },
    renderResult(result: any, options: any, theme: any) {
      const count = result?.details?.focusables?.length || 0;
      return renderComp([theme.fg("muted", `Probed ${count} focusable ${count === 1 ? "element" : "elements"}`)]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_resize
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_resize",
    label: "Resize TUI",
    description: "Resize the terminal dimensions of a running TUI session. The application receives SIGWINCH and re-renders. Useful when a TUI needs more columns to display content properly (e.g. wide tables, side-by-side panels). Default is 100x30.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      cols: z.number().describe("New width"),
      rows: z.number().describe("New height"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("resize", {
        id: params.id || lastSessionId,
        cols: params.cols,
        rows: params.rows,
      });

      return { content: [{ type: "text", text: result.formatted }] };
    },
    renderCall(args: any, theme: any) {
      return renderComp([theme.fg("muted", `Resizing to ${args.cols}×${args.rows}...`)]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_send_raw
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_send_raw",
    label: "Send Raw to TUI",
    description: "Send raw bytes/escape sequences to a TUI without settlement detection. Use for streaming input, real-time control, or sending sequences not covered by named keys. Supports \\x1b for ESC, \\n for newline, \\r for carriage return, \\t for tab. Prefer tui_interact for normal keystrokes — use this only for escape sequences.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      data: z.string().describe("Raw string to send. Supports escape sequences like \\x1b for ESC."),
      wait_ms: z.number().default(0).describe("Ms to wait after sending (no capture)"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("send_raw", {
        id: params.id || lastSessionId,
        data: params.data,
        wait_ms: params.wait_ms,
      });

      return { content: [{ type: "text", text: result.formatted }] };
    },
    renderCall(args: any, theme: any) {
      const preview = (args.data || "").substring(0, 40);
      return renderComp([theme.fg("muted", `┌─ Raw send (${args.data?.length || 0} bytes)`), theme.fg("muted", "│  ") + preview, theme.fg("muted", "└─")]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_close
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_close",
    label: "Close TUI",
    description: "Kill a TUI session. Use force:true for SIGKILL (hard kill) instead of default SIGTERM (graceful). The session is removed from the active list. Attempting to close a non-existent session returns an error. Sessions are NOT auto-closed between turns — close them when done to free resources.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      force: z.boolean().default(false).describe("Use SIGKILL instead of SIGTERM"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("close", {
        id: params.id || lastSessionId,
        force: params.force,
      });

      return { content: [{ type: "text", text: result.formatted }], ...(result.success === false ? { isError: true } : {}) };
    },
    renderCall(args: any, theme: any) {
      return renderComp([theme.fg("muted", `Closing ${args.id || "default session"}...`)]);
    },
    renderResult(result: any, options: any, theme: any) {
      const ok = !result?.isError;
      return renderComp([ok ? theme.fg("success", "Closed ✓") : theme.fg("warning", "Not found")]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_list
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_list",
    label: "List TUIs",
    description: "List all active TUI sessions with their IDs, commands, dimensions, and uptime. Use this to discover available sessions before interacting. The first session opened becomes the default target for other tools when id is omitted.",
    parameters: z.object({}),
    async execute(_tcid, _params, _signal, _onUpdate, _ctx) {
      const result = await call("list", {});

      return { content: [{ type: "text", text: result.formatted }] };
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const sessionLines = text.split("\n").filter((l: string) => l.startsWith("- ")) || [];
      return renderComp([
        theme.fg("muted", `┌─ Active Sessions (${sessionLines.length})`),
        ...sessionLines.slice(0, 10).map((l: string) => {
          const id = l.match(/`([^`]+)`/)?.[1] || "?";
          const rest = l.replace(/^- `[^`]+`/, "").trim();
          return theme.fg("muted", "│ ") + " " + theme.fg("success", "●") + " " + theme.fg("accent", id) + " " + theme.fg("muted", rest.substring(0, 50));
        }),
        theme.fg("muted", "└─"),
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_session — unified session state
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_session",
    label: "TUI Session State",
    description: "Get the full state of all TUI sessions. Returns active sessions with IDs, commands, uptime, and dimensions. The 'current' field shows the default session ID used when id is omitted from other tools. Use this to discover sessions before interacting, or to check which session is the current default.",
    parameters: z.object({}),
    async execute(_tcid, _params, _signal, _onUpdate, _ctx) {
      const result = await call("list", {});

      let out = result.formatted;
      if (lastSessionId) {
        out += `\n**Current session**: \`${lastSessionId}\` (default for tools when ` + "`id`" + ` is omitted)`;
      }

      return {
        content: [{ type: "text", text: out }],
        details: { currentSessionId: lastSessionId || null },
      };
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const sessionLines = text.split("\n").filter((l: string) => l.startsWith("- ")) || [];
      const current = result?.details?.currentSessionId;
      const items = [
        theme.fg("muted", `┌─ Active Sessions (${sessionLines.length})`),
        ...sessionLines.slice(0, 10).map((l: string) => {
          const id = l.match(/`([^`]+)`/)?.[1] || "?";
          const isCurrent = current && l.includes(current);
          const marker = isCurrent ? theme.fg("success", "●") : theme.fg("muted", "○");
          const rest = l.replace(/^- `[^`]+`/, "").trim();
          return theme.fg("muted", "│ ") + " " + marker + " " + theme.fg("accent", id) + " " + theme.fg("muted", rest.substring(0, 50));
        }),
      ];
      if (current) {
        items.push(theme.fg("muted", "└─ Default: ") + theme.fg("accent", current));
      } else {
        items.push(theme.fg("muted", "└─"));
      }
      return renderComp(items);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_exec — execute command, return immediately
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_exec",
    label: "Execute in TUI",
    description: "Execute a command in an existing TUI session and return immediately WITHOUT waiting for output. The command runs asynchronously. IMPORTANT: To read the output, call tui_output afterwards (with wait_ms to give the command time to produce output), or use tui_wait to wait for a specific pattern to appear. Pattern: tui_exec → tui_output(wait_ms:500) to see results. For commands that produce output slowly, use tui_exec → tui_wait(pattern:'...') → tui_output.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      command: z.string().describe("Command to execute (will be followed by Enter)"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("exec", {
        id: params.id || lastSessionId,
        command: params.command,
      });

      return {
        content: [{ type: "text", text: result.formatted }],
        details: { sessionId: result.sessionId, command: result.command },
      };
    },
    renderCall(args: any, theme: any) {
      return renderComp([
        theme.fg("muted", "┌─ Executing in ") + theme.fg("accent", args.id || "default"),
        theme.fg("muted", "│  ") + (args.command || "?"),
        theme.fg("muted", "└─ ") + theme.fg("warning", "→ use tui_output or tui_wait to see results"),
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_output — read accumulated session output
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_output",
    label: "Read TUI Output",
    description: "Read accumulated output from a TUI session. Returns the visible screen AND recent scrollback history. Use after tui_exec to see command results. Set wait_ms to wait for new output before capturing (e.g. 500ms for fast commands, 2000ms for slower ones). Use offset and limit to paginate through scrollback history. The screen section shows what's currently visible; Scrollback section shows older output that scrolled off.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      wait_ms: z.number().default(500).describe("Wait up to this many ms for new output before returning (500ms default gives most commands time to produce output)"),
      offset: z.number().default(0).describe("Scrollback offset (0 = most recent)"),
      limit: z.number().default(50).describe("Maximum scrollback lines to return"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("output", {
        id: params.id || lastSessionId,
        wait_ms: params.wait_ms,
        offset: params.offset,
        limit: params.limit,
      });

      return {
        content: [{ type: "text", text: result.formatted }],
        details: {
          hasScrollback: result.hasScrollback,
          scrollLines: result.scrollLines,
          cursorX: result.cursorX,
          cursorY: result.cursorY,
        },
      };
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/\*\*Screen\*\*:\n```\n([\s\S]*?)```/)?.[1] || "";
      const sb = result?.details?.scrollLines ? ` +${result.details.scrollLines} scrollback lines` : "";
      const lines = screenPreview(screenText, 6, 80, theme);
      return renderComp([
        theme.fg("muted", "┌─ Output") + sb,
        ...lines,
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_screenshot — visual terminal capture
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_screenshot",
    label: "Screenshot TUI",
    description: "Take a visual capture of the TUI screen with full ANSI color codes. Returns the screen as ANSI-formatted text that renders as colored output. Use this when visual appearance matters — colored output, syntax highlighting, terminal graphics. Defaults to include_ansi:true. For plain-text captures, use tui_capture instead.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      settle_ms: z.number().default(1000).describe("Maximum ms to wait for screen to settle"),
      include_ansi: z.boolean().default(true).describe("Include ANSI color codes (default true for screenshot)"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("capture", {
        id: params.id || lastSessionId,
        settle_ms: params.settle_ms,
        include_ansi: params.include_ansi,
        immediate: false,
      });

      return {
        content: [{ type: "text", text: result.formatted }],
        details: { cursorX: result.cursorX, cursorY: result.cursorY },
      };
    },
    renderResult(result: any, options: any, theme: any) {
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/```\n([\s\S]*?)```/)?.[1] || "";
      const hasAnsi = text.includes("```ansi");
      const lines = screenPreview(screenText, 6, 80, theme);
      return renderComp([
        theme.fg("muted", "┌─ Screenshot") + (hasAnsi ? theme.fg("success", " · ANSI colors") : ""),
        ...lines,
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool: tui_wait — wait for pattern in output
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "tui_wait",
    label: "Wait for TUI Pattern",
    description: "Poll a TUI session until a text pattern appears on screen, then return the screen. Use this to wait for command completion, prompts (pattern: '>'), or specific output before interacting. Timeout returns the current screen with found:false. Pattern is case-sensitive substring match. Typical use: tui_exec a long command, then tui_wait for 'COMPLETE' or '>' prompt. Poll interval 200ms default balances responsiveness with CPU.",
    parameters: z.object({
      id: z.string().optional().describe("Session ID (defaults to last opened)"),
      pattern: z.string().describe("Text pattern to wait for (substring match)"),
      timeout_ms: z.number().default(30000).describe("Maximum ms to wait (default 30s)"),
      poll_ms: z.number().default(200).describe("Polling interval in ms"),
    }),
    async execute(_tcid, params, _signal, _onUpdate, _ctx) {
      const result = await call("wait", {
        id: params.id || lastSessionId,
        pattern: params.pattern,
        timeout_ms: params.timeout_ms,
        poll_ms: params.poll_ms,
      });

      return {
        content: [{ type: "text", text: result.formatted }],
        details: { found: result.found, waitedMs: result.waitedMs },
      };
    },
    renderCall(args: any, theme: any) {
      return renderComp([
        theme.fg("muted", "┌─ Waiting in ") + theme.fg("accent", args.id || "default") + theme.fg("muted", ` · timeout ${(args.timeout_ms ?? 30000) / 1000}s`),
        theme.fg("muted", "│  Pattern: ") + theme.fg("warning", JSON.stringify(args.pattern || "?")),
        theme.fg("muted", "└─ ⠋ polling..."),
      ]);
    },
    renderResult(result: any, options: any, theme: any) {
      const found = result?.details?.found;
      const text = result?.content?.[0]?.text || "";
      const screenText = text.match(/```\n([\s\S]*?)```/)?.[1] || "";
      const lines = screenPreview(screenText, 5, 80, theme);
      return renderComp([
        theme.fg("muted", "┌─ Wait ") + (found ? theme.fg("success", "Pattern found ✓") + theme.fg("muted", ` · ${result?.details?.waitedMs}ms`) : theme.fg("warning", "Timeout — not found")),
        ...lines,
      ]);
    },
  });
}
