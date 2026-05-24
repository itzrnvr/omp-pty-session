# Testing System for OMP Extensions

Comprehensive testing infrastructure for Oh My Pi extensions. Tests extensions end-to-end in interactive mode inside real OMP sessions, provides TUI capture for debugging, and simulates LLM tool calls without real model costs.

## Quick Start

```bash
# From the extension directory:
bun run test-harness.ts      # 15 non-interactive tests (~5s)
bun run test-interactive.ts  # 8 interactive tests (~30s)
bun run test-runner.ts       # Both suites sequentially (~35s)
```

Expected output:
```
═══ Interactive Test Suite ═══
  ✓ tui_open: sid=tui-1779
  ✓ tui_interact: ```...```
  ✓ tui_list:
  ✓ tui_capture: 411 chars
  ✓ tui_close:
  ✓ screen stability: 2 captures
  ✓ invalid command: error
  ✓ invalid session close: error
8/8 interactive tests passed
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   TEST SYSTEM                           │
├─────────────────────────┬───────────────────────────────┤
│  test-harness.ts        │  test-interactive.ts          │
│  (Non-Interactive)      │  (Interactive)                │
├─────────────────────────┼───────────────────────────────┤
│  extFactory(mockPi)     │  extFactory(mockPi)           │
│       ↓                 │       ↓                       │
│  tools["name"].execute()│  createMockModel(responses)   │
│       ↓                 │       ↓                       │
│  Validate result        │  Agent({streamFn})            │
│       ↓                 │       ↓                       │
│  PASS/FAIL              │  AgentSession({agent})        │
│                         │       ↓                       │
│                         │  session.prompt("Test.")      │
│                         │       ↓                       │
│                         │  session.subscribe(events)    │
│                         │       ↓                       │
│                         │  Validate tool results        │
├─────────────────────────┴───────────────────────────────┤
│  test-runner.ts — unified entry point                   │
└─────────────────────────────────────────────────────────┘
```

### Two Test Modes

| | Non-Interactive (`test-harness.ts`) | Interactive (`test-interactive.ts`) |
|---|---|---|
| **Dispatch** | Direct `tool.execute()` call | MockModel → Agent → AgentSession |
| **LLM** | None required | MockModel (zero cost) |
| **Speed** | ~5s | ~30s (PTY spawn + settlement) |
| **Tests what** | Tool logic correctness | Full OMP pipeline: stream → tool_call → execution → result |
| **OMP SDK** | Not used | Uses `Agent`, `AgentSession`, `convertToLlm` |

---

## Writing a Non-Interactive Test (`test-harness.ts` pattern)

The non-interactive harness calls tool `execute()` methods directly through a mock ExtensionAPI. This is the fastest way to verify tool logic.

### 1. Import and collect tools

```typescript
import extFactory from "./index.ts";

const tools: Record<string, any> = {};

extFactory({
  setLabel: () => {},
  on: () => {},
  notify: () => {},
  registerTool: (def: any) => { tools[def.name] = def; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as any);
```

### 2. Call execute and validate

```typescript
async function test(name: string, fn: () => Promise<boolean>) {
  try {
    const ok = await fn();
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    return ok;
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e.message}`);
    return false;
  }
}

// Test a tool
await test("my_tool works", async () => {
  const result = await tools.my_tool.execute(
    "toolCallId",                    // tool call id (can be any string)
    { param: "value" },              // params matching the tool schema
    { aborted: false },              // AbortSignal (mock)
    () => {},                        // onUpdate callback (no-op)
    { cwd: process.cwd() },          // context (cwd required for shell tools)
  );
  return result.content[0].text.includes("expected output");
});
```

### 3. Tool execute signature

The 5-argument `execute` call pattern:
```
execute(toolCallId, params, signal, onUpdate, ctx)
```

| Arg | Type | Purpose |
|---|---|---|
| `toolCallId` | `string` | Unique call identifier |
| `params` | `object` | Tool parameters (must match schema) |
| `signal` | `AbortSignal` | Mock with `{ aborted: false }` |
| `onUpdate` | `(partial) => void` | Progress callback, `() => {}` for no-op |
| `ctx` | `object` | Context; `{ cwd: process.cwd() }` for shell tools |

---

## Writing an Interactive Test (`test-interactive.ts` pattern)

Interactive tests exercise the full OMP agent pipeline: the MockModel emits scripted tool calls, the Agent processes them, the AgentSession executes tools, and results are validated via event subscription.

### 1. Register the mock API

```typescript
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai";
import { Agent, convertToLlm } from "@oh-my-pi/pi-agent-core";
import { AgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";

registerMockApi(); // Required once before creating any MockModel
```

### 2. Collect extension tools

Same pattern as non-interactive — call the extension factory with a mock `pi`:

```typescript
import extFactory from "./index.ts";

const extTools = new Map<string, any>();
extFactory({
  setLabel: () => {}, on: () => {}, notify: () => {},
  registerTool: (d: any) => extTools.set(d.name, d),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as any);
```

### 3. Create MockModel with scripted tool calls

```typescript
const mock = createMockModel({
  id: "test-model",
  provider: "mock",
  responses: [
    // Each array entry is one turn's response.
    // { content: [{ type: "toolCall", name, arguments }] } makes the model call a tool.
    // { content: ["text"] } makes the model respond with text.
    {
      content: [{
        type: "toolCall",
        name: "my_tool",
        arguments: { param: "value" },
      }],
    },
    { content: ["All tests passed."], stopReason: "stop" },
  ],
});
```

### 4. Create Agent and AgentSession

```typescript
const tools = [...extTools.values()];
const toolMap = new Map(tools.map((t: any) => [t.name, t]));

const agent = new Agent({
  getApiKey: () => "test-key",       // Bypasses auth
  initialState: {
    model: mock.model,
    systemPrompt: ["Test harness."],
    tools,
    messages: [],
  },
  convertToLlm,                        // Converts AgentMessage[] to LLM Message[]
  streamFn: mock.stream,              // Mock stream function
});

const session = new AgentSession({
  agent,
  sessionManager: SessionManager.inMemory(tempDir),
  settings: Settings.isolated({ "compaction.enabled": false }),
  modelRegistry: { getApiKey: () => "test-key" } as any,
  toolRegistry: toolMap,
});
```

### 5. Run prompt and collect results

```typescript
const toolResults = new Map<string, any>();
let completed = false;

const unsub = session.subscribe((event: any) => {
  if (event.type === "tool_execution_end") {
    toolResults.set(event.toolName, event.result);
  } else if (event.type === "agent_end") {
    completed = true;
  }
});

await session.prompt("Run the test plan.");

// Poll until agent finishes (polling pattern required because
// prompt() returns immediately; actual work happens asynchronously)
const deadline = Date.now() + 30_000;
while (!completed && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 200));
}

unsub();

// Validate
const result = toolResults.get("my_tool");
console.log(result?.content?.[0]?.text);
```

### 6. Key events to listen for

| Event type | Contains | Use for |
|---|---|---|
| `tool_execution_start` | `toolName` | Logging, timing |
| `tool_execution_end` | `toolName`, `result` | Validating tool output |
| `message_start` / `message_update` / `message_end` | `message` (role, content) | Tracking conversation state |
| `agent_start` / `agent_end` | — | Knowing when to stop polling |

### 7. Response types in MockModel

```typescript
// Tool call — model requests tool execution
{ content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }] }

// Text response — model replies with text
{ content: ["Plain text response."] }

// Explicit text block
{ content: [{ type: "text", text: "Hello" }] }

// Thinking block (reasoning models)
{ content: [{ type: "thinking", thinking: "Let me think..." }] }

// Error simulation
{ throw: new Error("Simulated failure") }

// Stop reason control
{ content: ["done"], stopReason: "stop" }    // Normal completion
{ content: [...], stopReason: "toolUse" }    // Model wants more tool calls

// Delayed response
{ content: ["slow"], delayMs: 500 }
```

### 8. Multi-turn patterns

For tests needing results from earlier tool calls, use the handler pattern:

```typescript
let sessionId = "";

const mock = createMockModel({
  handler: (context) => {
    // context.messages contains the conversation so far
    const lastTool = context.messages
      .filter(m => m.role === "toolResult")
      .slice(-1)[0];

    if (!sessionId) {
      // First turn: open session
      return { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe" } }] };
    }
    // Subsequent turns: use the session id
    return { content: [{ type: "toolCall", name: "tui_close", arguments: { id: sessionId } }] };
  },
});
```

---

## Testing Failure Cases

### Invalid tool inputs

```typescript
// Tool should return isError: true for invalid inputs
const mock = createMockModel({
  responses: [
    { content: [{ type: "toolCall", name: "my_tool", arguments: { bad_param: 999 } }] },
    { content: ["done."], stopReason: "stop" },
  ],
});

const r = toolResults.get("my_tool");
assert(r.isError === true); // Tool should signal failure
```

### Non-existent resources

```typescript
// Tool should handle missing resources gracefully
{ content: [{ type: "toolCall", name: "tui_close", arguments: { id: "nonexistent" } }] }
// → Expect error or "not found" message
```

### Escaping/stability

```typescript
// Screen should be stable across captures (no flicker)
// Take two captures, compare screens using regex to strip metadata
const s1 = captures[0].text.match(/```\n([\s\S]*?)```/)?.[1] ?? "";
const s2 = captures[1].text.match(/```\n([\s\S]*?)```/)?.[1] ?? "";
assert(s1 === s2);
```

---

## Adapting for a New Extension

To write tests for a new extension, copy this pattern:

### 1. Create test-harness.ts

```typescript
import extFactory from "./index.ts";

const tools: Record<string, any> = {};
const results: { tool: string; status: "PASS" | "FAIL"; detail: string }[] = [];

extFactory({
  setLabel: () => {}, on: () => {}, notify: () => {},
  registerTool: (def: any) => { tools[def.name] = def; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as any);

async function test(name: string, fn: () => Promise<boolean>) {
  try {
    const ok = await fn();
    results.push({ tool: name, status: ok ? "PASS" : "FAIL", detail: ok ? "" : "unexpected result" });
  } catch (e: any) {
    results.push({ tool: name, status: "FAIL", detail: e.message || String(e) });
  }
}

async function main() {
  // Test each tool
  await test("my_tool basic", async () => {
    const r = await tools.my_tool.execute("id1", { param: "test" }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("expected");
  });

  // Report
  const passed = results.filter(r => r.status === "PASS").length;
  console.log(`\n${passed}/${results.length} passed`);
  for (const r of results) console.log(`  ${r.status === "PASS" ? "✓" : "✗"} ${r.tool} ${r.detail}`);
  if (passed < results.length) process.exit(1);
}
main();
```

### 2. Create test-interactive.ts

Copy the full pattern from the pty-session `test-interactive.ts`. Change:
- The import path for `extFactory`
- The `responses` array to match your tools
- The validation logic in the test cases

### 3. Optional: Create test-runner.ts

```typescript
// Runs both suites, reports aggregate results
import { spawnSync } from "child_process";
function run(label: string, file: string) {
  const r = spawnSync("bun", ["run", file], { cwd: __dirname, stdio: "inherit", timeout: 60_000 });
  console.log(`${r.status === 0 ? "✓" : "✗"} ${label}`);
}
run("Non-Interactive", "test-harness.ts");
run("Interactive", "test-interactive.ts");
```

---

## Common Pitfalls

### `ctx.cwd` is undefined
The `Agent` loop passes 4 arguments to tool `execute()`: `(toolCallId, params, signal, onUpdate)`. Extension tools expecting a 5th `ctx` argument get `undefined`. Fix:

```typescript
// In the tool:
async execute(_tcid, params, signal, _onUpdate, ctx) {
  const cwd = params.cwd ?? ctx?.cwd ?? process.cwd(); // Safe fallback
}
```

### `session.subscribe is not a function`
`createAgentSession` returns `{ session, ... }` — not a session directly. Destructure:
```typescript
const { session } = await createAgentSession({ ... });
// NOT: const session = await createAgentSession({ ... });
```

### Agent hangs after prompt
`session.prompt()` returns immediately. The agent runs asynchronously. Poll for completion:
```typescript
let completed = false;
session.subscribe(e => { if (e.type === "agent_end") completed = true; });
await session.prompt("test");
while (!completed) await new Promise(r => setTimeout(r, 200));
```

### "No API key found" error
Pass a fake model registry:
```typescript
modelRegistry: { getApiKey: () => "test-key" } as any
```

### Tool `id` parameter required but unknown at script time
Make `id` optional in tool schemas, default to most recent session:
```typescript
// In the extension:
let lastSessionId = "";
// In tui_open.execute: lastSessionId = result.id;
// In other tools: id: z.string().optional()
//                id: params.id || lastSessionId
```

### Screen stability test fails with identical screens
Capture tools include metadata (timestamps, sample counts) that differs between runs even when the screen is identical. Extract only the screen content:
```typescript
const screen = result.text.match(/```\n([\s\S]*?)```/)?.[1] ?? "";
```

---

## Dependencies

All test imports come from OMP packages that are already installed as extension dependencies:

```json
{
  "dependencies": {
    "@oh-my-pi/pi-ai": "*",         // createMockModel, registerMockApi
    "@oh-my-pi/pi-agent-core": "*", // Agent, convertToLlm
    "@oh-my-pi/pi-coding-agent": "*" // AgentSession, SessionManager, Settings
  }
}
```

No additional test frameworks required — the system uses plain `bun run` with built-in assertions.

---

## Test Suite Reference

### pty-session extension test coverage

| Category | Non-Interactive Tests | Interactive Tests |
|---|---|---|
| `tui_open` | Opens cmd.exe, validates Windows banner | ✓ (via MockModel tool call) |
| `tui_interact` | Echo text, arrow key recall | ✓ (via MockModel tool call) |
| `tui_capture` | Screen capture | ✓ + stability across captures |
| `tui_list` | Active sessions, empty list | ✓ |
| `tui_close` | Close session, validate empty list | ✓ |
| `tui_probe` | Focusable element detection | — |
| `tui_resize` | Resize and verify dimensions | — |
| `tui_send_raw` | Raw byte transmission | — |
| Temp-dir fallback | Simulates OMP copy to %TEMP% | — |
| Cursor position | Verifies prompt ends with `>` | — |
| Invalid command | — | ✓ (nonexistent binary) |
| Invalid close | — | ✓ (nonexistent session ID) |
| **Total** | **15** | **8** |
