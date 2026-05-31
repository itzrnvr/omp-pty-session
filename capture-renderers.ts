// capture-renderers.ts — Capture exact renderer output strings
import extFactory from "./index.ts";

// Mock theme that captures color calls
const captured: { tool: string; type: string; lines: string[] }[] = [];

function createCapturingTheme(tool: string, type: string) {
  return {
    fg: (color: string, text: string) => {
      const prefix = `[${color}]`;
      return prefix + text;
    }
  };
}

// Mock ExtensionAPI that captures render output
const toolMap = new Map<string, any>();
extFactory({
  setLabel: () => {},
  on: () => {},
  notify: () => {},
  registerTool: (def: any) => {
    toolMap.set(def.name, def);
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

// Test data
const testData: Record<string, { callArgs: any; result: any }> = {
  tui_open: {
    callArgs: { command: "cmd.exe", cols: 80, rows: 24, id: "tui-test" },
    result: { details: { id: "tui-123", command: "cmd.exe", cols: 80, rows: 24 }, meta: { durationMs: 450 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_interact: {
    callArgs: { id: "tui-123", keys: ["echo", "hello", "enter"] },
    result: { details: { strategy: "frame-diff", waitedMs: 1200 }, meta: { durationMs: 1200 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_capture: {
    callArgs: { id: "tui-123" },
    result: { meta: { durationMs: 80 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_probe: {
    callArgs: { id: "tui-123", max_tabs: 5 },
    result: { details: { focusables: [{ tabIndex: 0, cursorX: 10, cursorY: 5 }, { tabIndex: 1, cursorX: 20, cursorY: 8 }] }, meta: { durationMs: 300 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_resize: {
    callArgs: { id: "tui-123", cols: 100, rows: 30 },
    result: { details: { cols: 100, rows: 30 }, meta: { durationMs: 50 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_send_raw: {
    callArgs: { id: "tui-123", data: "\x1b[c" },
    result: { meta: { durationMs: 20 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_close: {
    callArgs: { id: "tui-123" },
    result: { meta: { durationMs: 100 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_list: {
    callArgs: {},
    result: { meta: { durationMs: 30 }, content: [{ type: "text", text: "- `tui-123`: cmd.exe\n  pid=1234, 80x24, cwd=C:\\tmp" }] }
  },
  tui_session: {
    callArgs: {},
    result: { details: { currentSessionId: "tui-123" }, meta: { durationMs: 30 }, content: [{ type: "text", text: "- `tui-123`: cmd.exe\n  pid=1234, 80x24, cwd=C:\\tmp" }] }
  },
  tui_exec: {
    callArgs: { id: "tui-123", command: "dir" },
    result: { details: { command: "dir", sessionId: "tui-123" }, meta: { durationMs: 200 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_output: {
    callArgs: { id: "tui-123", wait_ms: 500 },
    result: { details: { scrollLines: 50 }, meta: { durationMs: 500 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_screenshot: {
    callArgs: { id: "tui-123" },
    result: { meta: { durationMs: 150 }, content: [{ type: "text", text: "ok" }] }
  },
  tui_wait: {
    callArgs: { id: "tui-123", pattern: ">", timeout_ms: 5000 },
    result: { details: { found: true, waitedMs: 1200 }, meta: { durationMs: 1200 }, content: [{ type: "text", text: "ok" }] }
  },
};

console.log("=== Renderer Output Capture ===\n");

for (const [name, data] of Object.entries(testData)) {
  const tool = toolMap.get(name);
  if (!tool) {
    console.log(`${name}: NOT FOUND`);
    continue;
  }

  console.log(`## ${name}\n`);

  // Call renderCall
  if (tool.renderCall) {
    const theme = createCapturingTheme(name, "call");
    const comp = tool.renderCall(data.callArgs, theme);
    const lines = comp.render(100);
    console.log("renderCall:");
    for (const line of lines) {
      console.log("  " + JSON.stringify(line));
    }
    console.log("");
  }

  // Call renderResult
  if (tool.renderResult) {
    const theme = createCapturingTheme(name, "result");
    const comp = tool.renderResult(data.result, data.callArgs, theme);
    const lines = comp.render(100);
    console.log("renderResult:");
    for (const line of lines) {
      console.log("  " + JSON.stringify(line));
    }
    console.log("\n---\n");
  }
}
