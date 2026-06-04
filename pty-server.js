// pty-server.js — Node.js PTY backend for tui-bridge
// Communicates over stdin/stdout JSON-RPC to avoid Bun's broken conpty pipe handling

const { spawn } = require("node-pty");
const { Terminal } = require("@xterm/headless");

// ── Constants ──

const SPINNER_CHARS = new Set([
  "⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏",
  "◐","◓","◑","◒","◴","◵","◶","◷",
  "◢","◣","◤","◥","◰","◱","◲","◳",
  "|","/","-","\\",
]);

const PROGRESS_CHARS = new Set([
  "█","▉","▊","▋","▌","▍","▎","▏",
  "▓","▒","░",
  "■","□","▪","▫","◾","◽",
]);

const BOX_DRAWING = new Set([
  "─","━","│","┃","┌","┍","┎","┏","┐","┑","┒","┓",
  "└","┕","┖","┗","┘","┙","┚","┛","├","┝","┞","┟",
  "┠","┡","┢","┣","┤","┥","┦","┧","┨","┩","┪","┫",
  "┬","┭","┮","┯","┰","┱","┲","┳","┴","┵","┶","┷",
  "┸","┹","┺","┻","┼","┽","┾","┿","╀","╁","╂","╃",
  "╄","╅","╆","╇","╈","╉","╊","╋","╌","╍","╎","╏",
  "═","║","╒","╓","╔","╕","╖","╗","╘","╙","╚","╛",
  "╜","╝","╞","╟","╠","╡","╢","╣","╤","╥","╦","╧",
  "╨","╩","╪","╫","╬","╭","╮","╯","╰","╱","╲","╳",
  "╴","╵","╶","╷","╸","╹","╺","╻","╼","╽","╾","╿",
]);

const KEY_MAP = {
  enter: "\r\n", escape: "\x1b", tab: "\t", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
  delete: "\x1b[3~", insert: "\x1b[2~",
  ctrl_a: "\x01", ctrl_b: "\x02", ctrl_c: "\x03", ctrl_d: "\x04",
  ctrl_e: "\x05", ctrl_f: "\x06", ctrl_g: "\x07", ctrl_h: "\x08",
  ctrl_i: "\t", ctrl_j: "\n", ctrl_k: "\x0b", ctrl_l: "\x0c",
  ctrl_m: "\r", ctrl_n: "\x0e", ctrl_o: "\x0f", ctrl_p: "\x10",
  ctrl_q: "\x11", ctrl_r: "\x12", ctrl_s: "\x13", ctrl_t: "\x14",
  ctrl_u: "\x15", ctrl_v: "\x16", ctrl_w: "\x17", ctrl_x: "\x18",
  ctrl_y: "\x19", ctrl_z: "\x1a",
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS",
  f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~", f8: "\x1b[19~",
  f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
  // Alt combinations (ESC + char)
  alt_a: "\x1ba", alt_b: "\x1bb", alt_c: "\x1bc", alt_d: "\x1bd",
  alt_e: "\x1be", alt_f: "\x1bf", alt_g: "\x1bg", alt_h: "\x1bh",
  alt_i: "\x1bi", alt_j: "\x1bj", alt_k: "\x1bk", alt_l: "\x1bl",
  alt_m: "\x1bm", alt_n: "\x1bn", alt_o: "\x1bo", alt_p: "\x1bp",
  alt_q: "\x1bq", alt_r: "\x1br", alt_s: "\x1bs", alt_t: "\x1bt",
  alt_u: "\x1bu", alt_v: "\x1bv", alt_w: "\x1bw", alt_x: "\x1bx",
  alt_y: "\x1by", alt_z: "\x1bz",
  alt_1: "\x1b1", alt_2: "\x1b2", alt_3: "\x1b3", alt_4: "\x1b4",
  alt_5: "\x1b5", alt_6: "\x1b6", alt_7: "\x1b7", alt_8: "\x1b8",
  alt_9: "\x1b9", alt_0: "\x1b0",
  alt_enter: "\x1b\r", alt_space: "\x1b ", alt_tab: "\x1b\t",
  alt_backspace: "\x1b\x7f", alt_delete: "\x1b\x1b[3~",
  alt_up: "\x1b\x1b[A", alt_down: "\x1b\x1b[B",
  alt_left: "\x1b\x1b[D", alt_right: "\x1b\x1b[C",
  // Special characters
  left_parenthesis: "(", right_parenthesis: ")",
  left_brace: "{", right_brace: "}",
  left_bracket: "[", right_bracket: "]",
  less_than: "<", greater_than: ">",
  pipe: "|", backslash: "\\", slash: "/",
  colon: ":", semicolon: ";",
  single_quote: "'", double_quote: '"',
  comma: ",", period: ".", question_mark: "?",
  exclamation: "!", at_sign: "@",
  hash: "#", dollar: "$", percent: "%",
  caret: "^", ampersand: "&", asterisk: "*",
  minus: "-", underscore: "_", plus: "+", equals: "=",
  tilde: "~", backtick: "`",
};

// ── Types ──

const sessions = new Map();

// ── Hashing & Masking ──

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function maskCell(cell, cursorX, cursorY) {
  if (cell.x === cursorX && cell.y === cursorY) return "{CURSOR}";
  if (SPINNER_CHARS.has(cell.char)) return "{SPIN}";
  if (PROGRESS_CHARS.has(cell.char)) return "{PROG}";
  return cell.char;
}

function computeMaskedHash(cells, cursorX, cursorY) {
  let s = "";
  for (const row of cells) {
    for (const cell of row) s += maskCell(cell, cursorX, cursorY);
    s += "\n";
  }
  return hashString(s);
}

function computeRawHash(cells) {
  let s = "";
  for (const row of cells) {
    for (const cell of row) s += cell.char;
    s += "\n";
  }
  return hashString(s);
}

// ── Screen Capture ──

function readBuffer(term) {
  const buf = term.buffer.active;
  const cells = [];
  const cursorX = buf.cursorX;
  const cursorY = buf.cursorY + buf.viewportY;

  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    const line = buf.getLine(y);
    const row = [];
    if (!line) { cells.push(row); continue; }
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      row.push({
        x, y,
        char: cell.getChars() || " ",
        width,
        fg: cell.getFgColor(),
        bg: cell.getBgColor(),
        bold: !!cell.isBold(),
        inverse: !!cell.isInverse(),
        italic: !!cell.isItalic(),
        underline: !!cell.isUnderline(),
        isBoxDrawing: BOX_DRAWING.has(cell.getChars() || ""),
      });
    }
    cells.push(row);
  }
  return { cells, cursorX, cursorY };
}

function renderText(cells) {
  const lines = [];
  for (const row of cells) {
    let line = "";
    for (const cell of row) line += cell.char;
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function renderAnsi(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) { lines.push(""); continue; }
    let out = "";
    let lastFg = -1, lastBg = -1, lastBold = false, lastInverse = false;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const fg = cell.getFgColor(), bg = cell.getBgColor();
      const bold = !!cell.isBold(), inverse = !!cell.isInverse();
      if (fg !== lastFg || bg !== lastBg || bold !== lastBold || inverse !== lastInverse) {
        const codes = [];
        if (inverse) codes.push(7);
        if (bold) codes.push(1);
        if (fg >= 0 && fg < 256) { if (fg < 8) codes.push(30+fg); else if (fg < 16) codes.push(90+fg-8); else codes.push(38,5,fg); }
        if (bg >= 0 && bg < 256) { if (bg < 8) codes.push(40+bg); else if (bg < 16) codes.push(100+bg-8); else codes.push(48,5,bg); }
        out += `\x1b[${codes.join(";")}m`;
        lastFg=fg; lastBg=bg; lastBold=bold; lastInverse=inverse;
      }
      out += cell.getChars() || " ";
    }
    out += "\x1b[0m";
    lines.push(out.trimEnd());
  }
  return lines.join("\n");
}

// ── Region Detection (simplified) ──

function detectRegions(cells, rows, cols) {
  // Simplified: classify by position heuristics
  const regions = [];
  const fullText = renderText(cells);
  
  // Single main region covering the whole screen
  regions.push({
    x: 0, y: 0, w: cols, h: rows,
    type: "main",
    content: fullText,
    contentHash: hashString(fullText),
    changeScore: 0,
    isStable: true,
  });
  return regions;
}

// ── Settlement Engine ──

function captureSettled(session, options = {}) {
  const {
    maxWaitMs = 2000,
    stabilityThreshold = 2,
    histogramThreshold = 0.25,
    maskAnimations = true,
    includeAnsi = false,
    fast = false,
  } = options;
  // Fast path: single frame capture with 100ms hard timeout
  if (fast) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      setTimeout(() => {
        const { cells, cursorX, cursorY } = readBuffer(session.term);
        const fullText = renderText(cells);
        const rawHash = computeRawHash(cells);
        const maskedHash = maskAnimations ? computeMaskedHash(cells, cursorX, cursorY) : rawHash;
        const regions = detectRegions(cells, session.rows, session.cols);
        const snapshot = { timestamp: Date.now(), rawHash, maskedHash, regions, fullText, cursorX, cursorY };
        resolve(buildResult(snapshot, [snapshot], "fast", startTime, includeAnsi, session));
      }, 100);
    });
  }
  // Adaptive sampling: start at 100ms, drop to 50ms after first change, back to 100ms if still changing after 1s
  const INITIAL_INTERVAL = 100;
  const FAST_INTERVAL = 50;
  const SLOW_INTERVAL = 100;
  const FAST_THRESHOLD_MS = 1000;
  return new Promise((resolve) => {
    const startTime = Date.now();
    const samples = [];
    const histogram = new Map();
    let lastMaskedHash = "";
    let stableCount = 0;
    let firstChangeTime = 0;
    let currentInterval = INITIAL_INTERVAL;
    let intervalId = null;
    const collectFrame = () => {
      const { cells, cursorX, cursorY } = readBuffer(session.term);
      const fullText = renderText(cells);
      const rawHash = computeRawHash(cells);
      const maskedHash = maskAnimations ? computeMaskedHash(cells, cursorX, cursorY) : rawHash;
      const regions = detectRegions(cells, session.rows, session.cols);
      return { timestamp: Date.now(), rawHash, maskedHash, regions, fullText, cursorX, cursorY };
    };
    const checkStability = (snapshot) => {
      const entry = histogram.get(snapshot.maskedHash);
      if (entry) entry.count++;
      else histogram.set(snapshot.maskedHash, { count: 1, snapshot });
      if (snapshot.maskedHash === lastMaskedHash) {
        stableCount++;
        if (stableCount >= stabilityThreshold) {
          clearInterval(intervalId);
          resolve(buildResult(snapshot, samples, "frame-diff", startTime, includeAnsi, session));
          return true;
        }
      } else {
        stableCount = 0;
        lastMaskedHash = snapshot.maskedHash;
        if (!firstChangeTime) firstChangeTime = Date.now();
      }
      const total = samples.length;
      if (total >= 5) {
        for (const [, { count, snapshot: hs }] of histogram) {
          if (count / total >= histogramThreshold) {
            clearInterval(intervalId);
            resolve(buildResult(hs, samples, "histogram", startTime, includeAnsi, session));
            return true;
          }
        }
      }
      if (Date.now() - startTime >= maxWaitMs) {
        clearInterval(intervalId);
        let bestSnapshot = samples[samples.length - 1];
        let bestCount = 0;
        for (const [, { count, snapshot }] of histogram) {
          if (count > bestCount) { bestCount = count; bestSnapshot = snapshot; }
        }
        resolve(buildResult(bestSnapshot, samples, "timeout", startTime, includeAnsi, session));
        return true;
      }
      // Adaptive interval: switch to fast after first change, back to slow if still changing after threshold
      if (firstChangeTime && currentInterval !== FAST_INTERVAL) {
        currentInterval = FAST_INTERVAL;
        clearInterval(intervalId);
        intervalId = setInterval(tick, FAST_INTERVAL);
      } else if (firstChangeTime && Date.now() - firstChangeTime > FAST_THRESHOLD_MS && currentInterval !== SLOW_INTERVAL) {
        currentInterval = SLOW_INTERVAL;
        clearInterval(intervalId);
        intervalId = setInterval(tick, SLOW_INTERVAL);
      }
      return false;
    };
    const tick = () => {
      const snapshot = collectFrame();
      samples.push(snapshot);
      checkStability(snapshot);
    };
    // Initial frame
    const initialFrame = collectFrame();
    samples.push(initialFrame);
    lastMaskedHash = initialFrame.maskedHash;
    // Start sampling
    intervalId = setInterval(tick, INITIAL_INTERVAL);
  });
}

function buildResult(snapshot, allSamples, strategy, startTime, includeAnsi, session) {
  const waitedMs = Date.now() - startTime;
  const animatedRegions = snapshot.regions
    .filter(r => !r.isStable && r.changeScore > 0.1)
    .map(r => `${r.type}@${r.x},${r.y}`);
  const isStable = strategy === "frame-diff" || (strategy === "histogram" && animatedRegions.length === 0);

  return {
    text: snapshot.fullText,
    ansiText: includeAnsi ? renderAnsi(session.term) : undefined,
    strategy,
    waitedMs,
    samples: allSamples.length,
    regions: snapshot.regions,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
    isStable,
    animatedRegions,
  };
}

function formatResult(result) {
  let out = "";
  out += "```\n" + result.text + "\n```\n\n";
  out += `**Capture**: ${result.strategy} | ${result.waitedMs}ms | ${result.samples} samples | Stable: ${result.isStable ? "yes" : "no"}\n`;
  out += `**Cursor**: (${result.cursorX}, ${result.cursorY})\n`;
  if (result.regions.length > 0) {
    out += "\n**Regions**:\n";
    for (const r of result.regions) {
      const stable = r.isStable ? "✓" : "✗";
      const change = Math.round(r.changeScore * 100);
      out += `  [${stable}] ${r.type} @(${r.x},${r.y}) ${r.w}×${r.h} | change:${change}%\n`;
      const firstLine = r.content.split("\n")[0]?.trim();
      if (firstLine && firstLine.length > 0 && firstLine.length < 60) out += `      └─ ${firstLine}\n`;
    }
  }
  if (result.animatedRegions.length > 0) out += `\n*Animated regions: ${result.animatedRegions.join(", ")}*\n`;
  if (result.ansiText) out += "\n**ANSI**:\n```ansi\n" + result.ansiText + "\n```\n";
  return out;
}

// ── Session Management ──

function killSession(id, force = false) {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.pty.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
  sessions.delete(id);
  return true;
}
function getSession(id) {
  const s = sessions.get(id);
  if (!s) return { error: `No active TUI session '${id}'. Open one first with tui_open. Use tui_list to see active sessions.` };
  if (s.dead) {
    const reason = s.exitSignal ? `signal ${s.exitSignal}` : `exit code ${s.exitCode ?? "unknown"}`;
    return { error: `Session '${id}' has exited (${reason}). The process died — this can happen if a command had a syntax error or the shell exited. You can still capture/output the final screen for 60s. Use tui_list to see all sessions.` };
  }
  return { session: s };
}
function requireAlive(session, id) {
  if (session.dead) {
    const reason = session.exitSignal ? `signal ${session.exitSignal}` : `exit code ${session.exitCode ?? "unknown"}`;
    return { error: `Session '${id}' has exited (${reason}) and cannot accept new input. The process died — this can happen if a command had a syntax error or the shell exited. Open a new session with tui_open.` };
  }
  return { ok: true };
}
// ── JSON-RPC Handler ──

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handle(msg);
    } catch (e) {
      send({ id: msg?.id, error: `Parse error: ${e.message}` });
    }
  }
});

process.stdin.on("end", () => {
  // Parent died, clean up
  for (const [id] of sessions) killSession(id, true);
  process.exit(0);
});

async function handle(msg) {
  const { id, method, params } = msg;

  try {
    let result;
    switch (method) {
      case "open": {
        const sessionId = params.id || `tui-${Date.now()}`;
        const cwd = params.cwd || process.cwd();

        if (sessions.has(sessionId)) {
          send({ id, error: `Session '${sessionId}' already exists. Use that existing session or close it first with tui_close.` });
          return;
        }

        let exe, spawnArgs;
        if (params.args && params.args.length > 0) {
          exe = params.command;
          spawnArgs = params.args;
        } else {
          const parts = params.command.split(" ").filter(Boolean);
          exe = parts[0];
          spawnArgs = parts.slice(1);
        }

        // Resolve bare command names via PATH (winpty doesn't resolve on Windows)
        if (!exe.includes("/") && !exe.includes("\\")) {
          try {
            const resolved = require("child_process").execSync(
              `where ${JSON.stringify(exe)}`, { encoding: "utf8", timeout: 3000 }
            ).split("\n")[0]?.trim();
            if (resolved) exe = resolved;
          } catch (_) { /* keep bare name, let spawn handle the error */ }
        }

        const pty = spawn(exe, spawnArgs, {
          name: "xterm-256color",
          cwd,
          cols: params.cols || 100,
          rows: params.rows || 30,
          env: (() => {
            const env = Object.assign({}, process.env);
            const extras = [
              env.USERPROFILE ? env.USERPROFILE + "\\.bun\\bin" : "",
              env.HOME ? env.HOME + "/.bun/bin" : "",
            ].filter(Boolean);
            const merged = [(env.PATH || env.Path || ""), ...extras].join(";");
            env.PATH = merged;
            env.Path = merged;
            return env;
          })(),
          useConpty: false,  // winpty — clean exit, full VT passthrough
        });

        const term = new Terminal({
          cols: params.cols || 100,
          rows: params.rows || 30,
          scrollback: 5000,
          allowProposedApi: true,
        });

        pty.onData((data) => term.write(data));
        pty.onExit(({ exitCode, signal }) => {
          process.stderr.write(`[pty-session] Session ${sessionId} exited (code=${exitCode}, signal=${signal})\n`);
          const s = sessions.get(sessionId);
          if (s) {
            s.dead = true;
            s.exitCode = exitCode;
            s.exitSignal = signal;
            s.deadAt = Date.now();
            // Grace period: keep dead session for 60s so user can still capture/output
            setTimeout(() => {
              if (sessions.get(sessionId)?.dead) {
                sessions.delete(sessionId);
                process.stderr.write(`[pty-session] Session ${sessionId} cleaned up after grace period\n`);
              }
            }, 60000);
          }
        });

        const session = {
          id: sessionId, pty, term,
          command: params.command, cwd,
          cols: params.cols || 100,
          rows: params.rows || 30,
          spawnTime: Date.now(),
          lastActivity: Date.now(),
        };

        sessions.set(sessionId, session);

        const captureResult = await captureSettled(session, {
          maxWaitMs: params.settle_ms || 2000,
          includeAnsi: params.include_ansi || false,
        });

        result = {
          formatted: formatResult(captureResult),
          id: sessionId,
          pid: pty.pid,
          command: params.command,
          cwd,
          cols: session.cols,
          rows: session.rows,
        };
        break;
      }

      case "interact": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;
        const alive = requireAlive(session, params.id);
        if (alive.error) { send({ id, error: alive.error }); return; }
        // All keys batched into one write
        let combined = "";
        for (const key of params.keys) combined += KEY_MAP[key] ?? key;
        try {
          session.pty.write(combined);
          session.lastActivity = Date.now();
        } catch (e) {
          const msg = e?.message || String(e);
          send({ id, error: `Write failed: ${msg}` });
          return;
        }

        const captureResult = await captureSettled(session, {
          maxWaitMs: params.settle_ms || 2000,
          includeAnsi: params.include_ansi || false,
        });

        result = {
          formatted: formatResult(captureResult),
          text: captureResult.text,
          cursorX: captureResult.cursorX,
          cursorY: captureResult.cursorY,
          strategy: captureResult.strategy,
          waitedMs: captureResult.waitedMs,
          samples: captureResult.samples,
          isStable: captureResult.isStable,
        };
        break;
      }

      case "capture": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;

        if (params.immediate) {
          const { cells, cursorX, cursorY } = readBuffer(session.term);
          const fullText = renderText(cells);
          const regions = detectRegions(cells, session.rows, session.cols);
          result = {
            formatted: formatResult({
              text: fullText,
              ansiText: params.include_ansi ? renderAnsi(session.term) : undefined,
              strategy: "immediate", waitedMs: 0, samples: 1, regions,
              cursorX, cursorY, isStable: false, animatedRegions: [],
            }),
          };
        } else {
          const captureResult = await captureSettled(session, {
            maxWaitMs: params.settle_ms || 1000,
            includeAnsi: params.include_ansi || false,
          });
          result = { formatted: formatResult(captureResult) };
        }
        break;
      }

      case "resize": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;
        const alive = requireAlive(session, params.id);
        if (alive.error) { send({ id, error: alive.error }); return; }

        session.pty.resize(params.cols, params.rows);
        session.term.resize(params.cols, session.rows = params.rows);
        session.cols = params.cols;

        await new Promise(r => setTimeout(r, 300));
        const captureResult = await captureSettled(session, { maxWaitMs: 1000 });
        result = { formatted: `Resized to ${params.cols}×${params.rows}\n\n` + formatResult(captureResult) };
        break;
      }

      case "close": {
        const ok = killSession(params.id, params.force);
        result = { formatted: ok ? `Closed ${params.id}` : `No active TUI session '${params.id}'. Use tui_list to see active sessions.`, success: ok };
        break;
      }

      case "list": {
        if (sessions.size === 0) {
          result = { formatted: "No active TUI sessions." };
        } else {
          let out = "**TUI Sessions**:\n\n";
          for (const [id, s] of sessions) {
            const uptime = Math.round((Date.now() - s.spawnTime) / 1000);
            const status = s.dead ? `DEAD (exit ${s.exitCode ?? s.exitSignal ?? 'unknown'})` : 'alive';
            out += `- \`${id}\`: ${s.command} [${status}]\n  pid=${s.pty.pid}, ${s.cols}×${s.rows}, cwd=${s.cwd}\n  uptime=${uptime}s${s.dead ? ', grace=60s' : ''}\n`;
          }
          result = { formatted: out };
        }
        break;
      }

      case "send_raw": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;
        const alive = requireAlive(session, params.id);
        if (alive.error) { send({ id, error: alive.error }); return; }

        const parsed = (params.data || "")
          .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t");

        // Debug: log what we received and parsed
        process.stderr.write(`[send_raw] Received: ${JSON.stringify(params.data)} (${(params.data || "").length} chars)\n`);
        process.stderr.write(`[send_raw] Parsed: ${JSON.stringify(parsed)} (${parsed.length} chars)\n`);
        try {
          session.pty.write(parsed);
          session.lastActivity = Date.now();
        } catch (e) {
          send({ id, error: `Write failed: ${e?.message || String(e)}` });
          return;
        }

        if (params.wait_ms > 0) await new Promise(r => setTimeout(r, params.wait_ms));
        result = { formatted: `Sent ${parsed.length} bytes.` };
        break;
      }

      case "exec": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;
        const alive = requireAlive(session, params.id);
        if (alive.error) { send({ id, error: alive.error }); return; }

        const cmd = params.command + "\r\n";
        try {
          session.pty.write(cmd);
          session.lastActivity = Date.now();
        } catch (e) {
          send({ id, error: `Write failed: ${e?.message || String(e)}` });
          return;
        }

        // Capture immediately to show what was written
        const { cells, cursorX, cursorY } = readBuffer(session.term);
        const fullText = renderText(cells);
        result = {
          formatted: `**Exec**: ${params.command}\n\n\`\`\`\n${fullText}\n\`\`\``,
          sessionId: session.id,
          command: params.command,
          cursorX, cursorY,
        };
        break;
      }

      case "output": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;

        const waitMs = params.wait_ms || 0;
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, Math.min(waitMs, 10000)));
        }

        const { cells, cursorX, cursorY } = readBuffer(session.term);
        const screenText = renderText(cells);

        // Also read scrollback
        const scrollLines = [];
        const offset = params.offset || 0;
        const limit = params.limit || 50;
        let scrollStart = Math.max(0, session.term.buffer.active.baseY - limit);
        if (offset > 0) scrollStart = Math.max(0, session.term.buffer.active.baseY - limit - offset);
        for (let y = scrollStart; y < session.term.buffer.active.baseY; y++) {
          const line = session.term.buffer.active.getLine(y);
          if (line) {
            let txt = "";
            for (let x = 0; x < line.length; x++) {
              const cell = line.getCell(x);
              if (cell) txt += cell.getChars() || " ";
            }
            scrollLines.push(txt.trimEnd());
          }
        }

        const scrollText = scrollLines.join("\n");

        result = {
          formatted: [
            scrollText ? `**Scrollback** (${scrollLines.length} lines):\n\`\`\`\n${scrollText}\n\`\`\`` : "",
            `**Screen**:\n\`\`\`\n${screenText}\n\`\`\``,
          ].filter(Boolean).join("\n\n"),
          hasScrollback: scrollLines.length > 0,
          scrollLines: scrollLines.length,
          cursorX, cursorY,
        };
        break;
      }

      case "wait": {
        const gs = getSession(params.id);
        if (gs.error) { send({ id, error: gs.error }); return; }
        const session = gs.session;

        const pattern = params.pattern;
        const timeoutMs = params.timeout_ms || 30000;
        const pollMs = params.poll_ms || 200;
        const deadline = Date.now() + timeoutMs;
        let found = false;
        let lastText = "";

        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, pollMs));
          const { cells } = readBuffer(session.term);
          const text = renderText(cells);
          if (text !== lastText) {
            lastText = text;
            if (text.includes(pattern)) {
              found = true;
              break;
            }
          }
        }

        const { cells, cursorX, cursorY } = readBuffer(session.term);
        const screenText = renderText(cells);

        result = {
          formatted: found
            ? `**Pattern found**: \`${pattern}\`\n\n\`\`\`\n${screenText}\n\`\`\``
            : `**Pattern not found** after ${timeoutMs}ms: \`${pattern}\`\n\n\`\`\`\n${screenText}\n\`\`\``,
          found,
          waitedMs: Math.min(timeoutMs, Date.now() - (deadline - timeoutMs)),
          cursorX, cursorY,
        };
        break;
      }

      case "ping": {
        result = { pong: true, sessions: sessions.size };
        break;
      }

      default:
        send({ id, error: `Unknown RPC method '${method}'. The extension and pty-server may be out of sync — reload the extension.` });
        return;
    }

    send({ id, result });
  } catch (e) {
    send({ id, error: e.message || String(e) });
  }
}

// Signal parent we're ready
send({ ready: true, pid: process.pid });
// Parent-pid heartbeat: exit if parent dies (prevents orphaned processes)
const ppid = process.ppid;
if (ppid) {
  const HEARTBEAT_MS = 5000;
  setInterval(() => {
    try {
      process.kill(ppid, 0); // check if parent exists
    } catch {
      process.stderr.write(`[pty-session] Parent ${ppid} gone, exiting\n`);
      for (const [id] of sessions) killSession(id, true);
      process.exit(0);
    }
  }, HEARTBEAT_MS);
}
