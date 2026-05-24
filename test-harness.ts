// test-harness.ts — Non-interactive tests for pty-session extension

import { createMockPi, TestSuite, extractScreen, screensMatch } from "../omp-test-harness/index";
import extFactory from "./index.ts";
import { mkdtempSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { tools } = createMockPi(extFactory);
const suite = new TestSuite("pty-session (Non-Interactive)");

async function main() {
  // ─── Temp-dir fallback ───
  await suite.test("temp-dir fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-legacy-pi-file-"));
    const dest = join(dir, "entry-abc", "module-xyz.ts");
    require("fs").mkdirSync(join(dir, "entry-abc"), { recursive: true });
    copyFileSync("./index.ts", dest);
    const tempMod = await import(dest.replace(/\\/g, "/"));
    const pi2 = createMockPi(tempMod.default);
    const r = await pi2.tools.get("tui_list")!.execute("tmp1", {}, { aborted: false }, () => {}, { cwd: process.cwd() });
    const ok = r.content[0].text.includes("No active");
    rmSync(dir, { recursive: true, force: true });
    return ok;
  });

  // ─── Functional tests ───
  let sid = "";

  await suite.test("tui_open cmd", async () => {
    const r = await tools.get("tui_open")!.execute("t1", { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 3000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    sid = r.details?.id;
    return !!sid && r.content[0].text.includes("Microsoft Windows");
  });

  await suite.test("tui_interact echo", async () => {
    const r = await tools.get("tui_interact")!.execute("t2", { id: sid, keys: ["e","c","h","o","space","P","A","S","S","enter"], settle_ms: 2000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("PASS");
  });

  await suite.test("tui_interact arrow", async () => {
    const r = await tools.get("tui_interact")!.execute("t3", { id: sid, keys: ["up", "enter"], settle_ms: 2000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return (r.content[0].text.match(/PASS/g) || []).length >= 2;
  });

  await suite.test("tui_interact special chars", async () => {
    const r = await tools.get("tui_interact")!.execute("t2b", { id: sid, keys: ["e","c","h","o","space","left_parenthesis","right_parenthesis","enter"], settle_ms: 1000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("()");
  });

  await suite.test("tui_capture", async () => {
    const r = await tools.get("tui_capture")!.execute("t4", { id: sid, settle_ms: 1000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("Capture");
  });

  await suite.test("tui_resize", async () => {
    const r = await tools.get("tui_resize")!.execute("t5", { id: sid, cols: 60, rows: 20 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("60");
  });

  await suite.test("tui_probe", async () => {
    const r = await tools.get("tui_probe")!.execute("t6", { id: sid, max_tabs: 3, settle_ms: 800 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("Focusable");
  });

  await suite.test("tui_send_raw", async () => {
    const r = await tools.get("tui_send_raw")!.execute("t7", { id: sid, data: "echo RAW_OK\\r\\n", wait_ms: 500 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("Sent");
  });

  await suite.test("tui_list", async () => {
    const r = await tools.get("tui_list")!.execute("t8", {}, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("cmd.exe");
  });

  await suite.test("tui_session state", async () => {
    const r = await tools.get("tui_session")!.execute("ss1", {}, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("cmd.exe") && r.content[0].text.includes("Current session");
  });

  // ─── New tools (before close) ───
  await suite.test("tui_exec basic", async () => {
    const r = await tools.get("tui_exec")!.execute("e1", { id: sid, command: "echo BACKGROUND_JOB_DONE" }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("Exec") && r.content[0].text.includes("BACKGROUND_JOB_DONE");
  });

  await suite.test("tui_output", async () => {
    const r = await tools.get("tui_output")!.execute("o1", { id: sid, wait_ms: 0, limit: 50 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    const text = r.content[0].text;
    return text.includes("**Screen**") && (text.includes("BACKGROUND_JOB_DONE") || text.includes("**Scrollback**") || text.includes("RAW_OK"));
  });

  await suite.test("tui_screenshot", async () => {
    const r = await tools.get("tui_screenshot")!.execute("sc1", { id: sid, settle_ms: 500, include_ansi: true }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("**Capture**") && r.content[0].text.includes("```ansi");
  });

  await suite.test("tui_wait pattern found", async () => {
    await tools.get("tui_exec")!.execute("e2", { id: sid, command: "echo WAIT_TARGET" }, { aborted: false }, () => {}, { cwd: process.cwd() });
    const r = await tools.get("tui_wait")!.execute("w1", { id: sid, pattern: "WAIT_TARGET", timeout_ms: 5000, poll_ms: 100 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.details?.found === true;
  });

  await suite.test("tui_wait pattern not found", async () => {
    const r = await tools.get("tui_wait")!.execute("w2", { id: sid, pattern: "ZZZ_NONEXISTENT_ZZZ", timeout_ms: 500, poll_ms: 100 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.details?.found === false;
  });

  // ─── Close and verify empty ───
  await suite.test("tui_close", async () => {
    const r = await tools.get("tui_close")!.execute("t9", { id: sid, force: true }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("Closed");
  });

  await suite.test("tui_list (empty)", async () => {
    const r = await tools.get("tui_list")!.execute("t10", {}, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("No active");
  });

  // ─── Rendering tests ───
  let sid2 = "";

  await suite.test("render: re-open", async () => {
    const r = await tools.get("tui_open")!.execute("rx", { command: "cmd.exe", cols: 80, rows: 24, settle_ms: 3000 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    sid2 = r.details?.id;
    return !!sid2 && r.content[0].text.includes("Microsoft Windows");
  });

  await suite.test("render: cursor pos", async () => {
    const r = await tools.get("tui_capture")!.execute("rr1", { id: sid2, settle_ms: 500, include_ansi: false }, { aborted: false }, () => {}, { cwd: process.cwd() });
    const promptLine = r.content[0].text.split("\n").find((l: string) => l.includes(">"));
    return !!promptLine && promptLine.endsWith(">");
  });

  await suite.test("render: stability", async () => {
    const a = await tools.get("tui_capture")!.execute("rr2a", { id: sid2, settle_ms: 500 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    const b = await tools.get("tui_capture")!.execute("rr2b", { id: sid2, settle_ms: 500 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return screensMatch(a, b);
  });

  await suite.test("render: echo output", async () => {
    const r = await tools.get("tui_interact")!.execute("rr3", { id: sid2, keys: ["e","c","h","o","space","R","E","N","D","E","R","enter"], settle_ms: 1500 }, { aborted: false }, () => {}, { cwd: process.cwd() });
    return r.content[0].text.includes("RENDER");
  });

  await tools.get("tui_close")!.execute("rx2", { id: sid2, force: true }, { aborted: false }, () => {}, { cwd: process.cwd() });

  if (!suite.report()) process.exit(1);
}

main().catch(e => { console.error("CRASH:", e); process.exit(1); });
