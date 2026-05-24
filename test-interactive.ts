// test-interactive.ts — Interactive tests for pty-session extension
// Run with: bun run test-interactive.ts
// Uses shared omp-test-harness for MockModel session + reporting.

import {
  createMockPi,
  createMockSession,
  runSession,
  extractScreen,
  screensMatch,
  TestSuite,
} from "../omp-test-harness/index";
import extFactory from "./index.ts";

const { tools, toolList } = createMockPi(extFactory);
const suite = new TestSuite("pty-session (Interactive)");

async function main() {
  // ── Tests 1-5: Full pipeline ──
  const { session: s1, dispose: d1 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 3000 } }] },
    { content: [{ type: "toolCall", name: "tui_interact", arguments: { keys: ["e","c","h","o","space","H","I","enter"], settle_ms: 1500 } }] },
    { content: [{ type: "toolCall", name: "tui_list", arguments: {} }] },
    { content: [{ type: "toolCall", name: "tui_capture", arguments: { settle_ms: 500 } }] },
    { content: [{ type: "toolCall", name: "tui_close", arguments: {} }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);

  const { toolResults: tr1 } = await runSession(s1, "Test.");

  suite.log(!!tr1.get("tui_open")?.details?.id, "tui_open",
    tr1.get("tui_open")?.details?.id ? "sid=" + tr1.get("tui_open").details.id.substring(0, 8) : "no sid");

  suite.log(tr1.get("tui_interact")?.content?.[0]?.text?.includes("HI") ?? false, "tui_interact",
    (tr1.get("tui_interact")?.content?.[0]?.text ?? "").substring(0, 60));

  suite.log(tr1.get("tui_list")?.content?.[0]?.text?.includes("cmd.exe") ?? false, "tui_list");

  suite.log((tr1.get("tui_capture")?.content?.[0]?.text?.length ?? 0) > 50, "tui_capture",
    `${tr1.get("tui_capture")?.content?.[0]?.text?.length ?? 0} chars`);

  suite.log(tr1.get("tui_close")?.content?.[0]?.text?.includes("Closed") ?? false, "tui_close");

  d1();

  // ── Test 6: Screen stability ──
  const { session: s2, dispose: d2 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 2000 } }] },
    { content: [{ type: "toolCall", name: "tui_capture", arguments: { settle_ms: 500 } }] },
    { content: [{ type: "toolCall", name: "tui_capture", arguments: { settle_ms: 500 } }] },
    { content: [{ type: "toolCall", name: "tui_close", arguments: {} }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);

  const { calls: calls2 } = await runSession(s2, "Test.");
  const captures = calls2.filter(c => c.name === "tui_capture");
  suite.log(
    captures.length >= 2 && screensMatch(captures[0].result, captures[1].result),
    "screen stability", `${captures.length} captures`,
  );
  d2();

  // ── Test 7: Invalid command ──
  const { session: s3, dispose: d3 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "nonexistent_xyz_cmd_99999", cols: 80, rows: 24, settle_ms: 2000 } }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);
  const { toolResults: tr3 } = await runSession(s3, "Test.");
  const r3 = tr3.get("tui_open");
  const r3text = (r3?.content?.[0]?.text ?? "").toLowerCase();
  suite.log(
    r3text.includes("not recognized") || r3text.includes("not found") || r3?.isError === true,
    "invalid command", r3?.isError ? "error" : (r3text.includes("not") ? "screen error" : "no error"),
  );
  d3();

  // ── Test 8: Invalid session close ──
  const { session: s4, dispose: d4 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_close", arguments: { id: "nonexistent-xyz", force: true } }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);
  const { toolResults: tr4 } = await runSession(s4, "Test.");
  const r4 = tr4.get("tui_close");
  const r4text = (r4?.content?.[0]?.text ?? "").toLowerCase();
  suite.log(
    r4?.isError === true || r4text.includes("not") || r4text.includes("no session"),
    "invalid session close", r4?.isError ? "error" : "no error",
  );
  d4();

  // ── Test 9-10: tui_exec + tui_output (background job pattern) ──
  const { session: s5, dispose: d5 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 2000 } }] },
    { content: [{ type: "toolCall", name: "tui_exec", arguments: { command: "echo BG_JOB_OK" } }] },
    { content: [{ type: "toolCall", name: "tui_output", arguments: { wait_ms: 0 } }] },
    { content: [{ type: "toolCall", name: "tui_close", arguments: {} }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);
  const { calls: calls5 } = await runSession(s5, "Test.");
  const execR = calls5.find(c => c.name === "tui_exec")?.result;
  const outR = calls5.find(c => c.name === "tui_output")?.result;
  suite.log(execR?.content?.[0]?.text?.includes("Exec") ?? false, "tui_exec (MockModel)");
  suite.log((outR?.content?.[0]?.text?.length ?? 0) > 100 || (outR?.content?.[0]?.text?.includes("BG_JOB_OK") ?? false),
    "tui_output (MockModel)", `${outR?.content?.[0]?.text?.length ?? 0} chars`);
  d5();

  // ── Test 11: tui_screenshot (visual capture) ──
  const { session: s6, dispose: d6 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 2000 } }] },
    { content: [{ type: "toolCall", name: "tui_screenshot", arguments: { settle_ms: 500, include_ansi: true } }] },
    { content: [{ type: "toolCall", name: "tui_close", arguments: {} }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);
  const { calls: calls6 } = await runSession(s6, "Test.");
  const scrR = calls6.find(c => c.name === "tui_screenshot")?.result;
  suite.log(
    (scrR?.content?.[0]?.text?.includes("Capture") || scrR?.content?.[0]?.text?.includes("```")) ?? false,
    "tui_screenshot (MockModel)",
  );
  d6();

  // ── Test 12: tui_wait ──
  const { session: s7, dispose: d7 } = createMockSession([
    { content: [{ type: "toolCall", name: "tui_open", arguments: { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 2000 } }] },
    { content: [{ type: "toolCall", name: "tui_exec", arguments: { command: "echo WAIT_FOR_ME" } }] },
    { content: [{ type: "toolCall", name: "tui_wait", arguments: { pattern: "WAIT_FOR_ME", timeout_ms: 5000, poll_ms: 100 } }] },
    { content: [{ type: "toolCall", name: "tui_close", arguments: {} }] },
    { content: ["done."], stopReason: "stop" },
  ], toolList);
  const { calls: calls7 } = await runSession(s7, "Test.");
  const waitR = calls7.find(c => c.name === "tui_wait")?.result;
  suite.log(waitR?.details?.found === true, "tui_wait (MockModel)", waitR?.details?.found ? "found" : "not found");
  d7();

  // ── Report ──
  if (!suite.report()) process.exit(1);
}

main().catch(e => { console.error("CRASH:", e); process.exit(1); });
