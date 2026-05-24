// test-runner.ts — Unified test runner for pty-session extension
// Run with: bun run test-runner.ts
// Uses shared omp-test-harness for running non-interactive and interactive suites.

import { TestSuite } from "../omp-test-harness/index";

const suite = new TestSuite("pty-session (Test Runner)");

// ─── Non-Interactive Tests ───
import "./test-harness"; // runs inline (uses its own suite)

// Note: test-harness already handles its own reporting.
// For the unified runner, we aggregate both suites' results.

// Simple aggregation — run both via bun.spawn for isolation
import { spawnSync } from "child_process";
import { join } from "path";

const extDir = join(import.meta.dirname ?? ".");

function runChild(label: string, file: string) {
  const start = Date.now();
  const result = spawnSync("bun", ["run", join(extDir, file)], {
    cwd: extDir,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 60_000,
    env: { ...process.env },
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const ok = result.status === 0;
  suite.log(ok, label, `${elapsed}s`);
  return ok;
}

// Run interactive as separate process (non-interactive already ran inline)
const interactiveOk = runChild("interactive suite", "test-interactive.ts");

suite.report();
if (!interactiveOk) process.exit(1);
