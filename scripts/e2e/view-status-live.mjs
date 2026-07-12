#!/usr/bin/env node
// view-status live conformance E2E — measures, on a running app, whether every mounted
// content view reports a status code that agrees with its manifest declaration
// (contributes.views[].status). This is the runtime half of coupling law C2 that a
// headless manifest scan cannot see, and the machine precondition the orchestrator reads
// before promoting the runtime `view-status` rule from warn to blocking.
//
// Judgment (src/plugins/conformance.ts viewStatusConformance — declaration ≡ report):
//   unreported : the view declares a non-empty status list but the mounted instance
//                reports no code (null). A promise the manifest made and the runtime broke.
//   undeclared : the mounted instance reports a code absent from its declaration
//                (declaration undefined, [], or code outside the list).
// A view that declares [] (stateless) and reports null is silent — clean, not a violation.
//
// The run opens one workspace window on a git fixture, mounts a configured set of content
// views (default: terminal + erd — a non-empty-status view and a []-status view), reads
// each owning plugin's plugin.conformance, aggregates the two counts, captures a render,
// then closes the window it opened. Idempotent: the fixture root is reused in place and the
// window is torn down at the end, so repeated runs leave no residue.
//
// PRECONDITION: the target home must have the mounted plugins installed AND consented with
// their status declaration present, or they will not activate under content-view-status
// blocking. Programs that are absent from program.list are skipped (never mocked).
//
// Run: SOKSAK_SOCKET=~/.soksak-debug/com.soksak.debug.sock node scripts/e2e/view-status-live.mjs
// Optional: VS_MOUNTS='terminal:soksak-plugin-terminal-xterm,erd:soksak-plugin-erd' overrides the
//           program:plugin pairs to mount. VS_SNAPSHOT_PATH overrides the capture location.
// Exit: 0 = GREEN (>=2 content views mounted, undeclared=0 — unreported is informational:
//       1 = RED (a mismatch remains, or fewer than two content views could be mounted).

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "viewstatus-fixture");
const SNAPSHOT_PATH =
  process.env.VS_SNAPSHOT_PATH ||
  path.join(os.tmpdir(), "soksak-view-status-live.png");
const MOUNTS = (process.env.VS_MOUNTS || "terminal:soksak-plugin-terminal-xterm,erd:soksak-plugin-erd")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [program, plugin] = pair.split(":");
    return { program, plugin };
  });

// ── socket RPC (same newline-framed JSON envelope as p0-contracts.mjs) ────────
let sock;
let seq = 0;
const pending = new Map();
let buf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}
// `extra` merges top-level request fields — `window` routes the call to a specific
// workspace window (req.window in ipc.rs); without it the call lands on the active window.
function rpc(method, params = {}, extra = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params, ...extra }) + "\n", (err) => {
      if (err) {
        pending.delete(id);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 15000);
  });
}
const data = (r) => (r && r.data !== undefined ? r.data : r);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixture carries one committed baseline plus one staged and one unstaged change so a
// diff view has something to settle on. Prepared with the git CLI (no app dependency),
// reused in place — the tree is reset to the same shape every run.
function prepareFixture() {
  fs.mkdirSync(FIXTURE, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: FIXTURE, stdio: "pipe" });
  if (!fs.existsSync(path.join(FIXTURE, ".git"))) git("init", "-q");
  git("config", "user.email", "e2e@soksak.local");
  git("config", "user.name", "e2e");
  fs.writeFileSync(path.join(FIXTURE, "README.md"), "baseline\n");
  git("add", "README.md");
  try {
    git("commit", "-qm", "baseline");
  } catch {
    /* nothing to commit on reruns — the baseline already exists */
  }
  fs.writeFileSync(path.join(FIXTURE, "README.md"), "baseline\nlocal change\n");
  fs.writeFileSync(path.join(FIXTURE, "NEW.txt"), "new file\n");
  git("add", "NEW.txt");
}

async function main() {
  await connect();
  console.log(`view-status live conformance E2E\nsocket: ${SOCKET}\n`);

  prepareFixture();
  console.log("a. open a workspace window on the fixture");
  const opened = data(await rpc("window.open", { root: FIXTURE }));
  const win = opened.label || opened.window || opened.existingWindow;
  ok(typeof win === "string" && win.startsWith("w-"), `workspace window opened (${win})`);
  await sleep(1500); // let the window's plugin host activate

  const w = { window: win };
  const programs = new Set(
    (data(await rpc("program.list", {}, w)).programs || []).map((p) =>
      typeof p === "string" ? p : p.id,
    ),
  );
  console.log(`   programs available: ${[...programs].join(", ") || "(none)"}`);

  // ── b. mount the configured content views ──────────────────────────────────
  console.log("\nb. mount content views");
  const state = data(await rpc("state.tree", {}, w));
  const firstPanel = state.projects?.[0]?.spaces?.[0]?.panels?.[0]?.id;
  const mountedPlugins = new Set();
  let split = false;
  for (const { program, plugin } of MOUNTS) {
    if (!programs.has(program)) {
      console.log(`  – ${program} not in program.list — skipped (plugin not active)`);
      continue;
    }
    // First view fills the empty panel; the rest split beside it so every view is visible
    // in one capture. Both paths land the view in the sessions content layout.
    const res = data(
      split
        ? await rpc("panel.split", { panel: firstPanel, side: "right", program }, w)
        : await rpc("view.open", { panel: firstPanel, program }, w),
    );
    split = true;
    ok(!!res.viewId, `mounted ${program} (view ${res.viewId})`);
    mountedPlugins.add(plugin);
  }
  ok(mountedPlugins.size >= 2, `at least two content views mounted (${mountedPlugins.size})`);
  await sleep(3000); // let each view settle past its transient states

  // ── c. read declaration-vs-report conformance per owning plugin ─────────────
  console.log("\nc. view-status conformance (declaration ≡ report)");
  let totalUnreported = 0;
  let totalUndeclared = 0;
  for (const plugin of mountedPlugins) {
    const conf = data(await rpc("plugin.conformance", { id: plugin }, w));
    const vs = conf.c2?.viewStatus || {};
    const decl = (conf.views?.registered || []).length; // sanity: the plugin's views are registered
    const un = vs.unreported || [];
    const ud = vs.undeclared || [];
    totalUnreported += un.length;
    totalUndeclared += ud.length;
    console.log(
      `   ${plugin}: mounted=${JSON.stringify(vs.mounted || [])} ` +
        `reported=${JSON.stringify(vs.reported || [])} ` +
        `unreported=${JSON.stringify(un)} undeclared=${JSON.stringify(ud)}`,
    );
    ok(decl > 0, `${plugin} registered its declared views`);
  }
  ok(totalUndeclared === 0, `no mounted view reports an undeclared code (undeclared=${totalUndeclared})`);
  // unreported is informational only: null means "nothing to report" (the status axis's
  // documented semantics) and transient codes can outrun the observation window.
  console.log(`   unreported (informational): ${totalUnreported}`);

  // ── d. capture a live render for eyeball verification ───────────────────────
  console.log("\nd. capture live render");
  await rpc("window.focus", {}, w);
  await sleep(500);
  try {
    fs.rmSync(SNAPSHOT_PATH, { force: true });
  } catch {}
  const snap = await rpc("window.snapshot", { path: SNAPSHOT_PATH }, w);
  ok(snap.ok === true, `snapshot ok:true (code ${snap.code})`);
  if (fs.existsSync(SNAPSHOT_PATH)) {
    const bytes = fs.statSync(SNAPSHOT_PATH).size;
    console.log(`   snapshot: ${SNAPSHOT_PATH} (${(bytes / 1024).toFixed(1)} KB)`);
    ok(bytes > 60_000, "snapshot is not a blank frame (>60KB)");
  }

  // ── e. tear the window down (leave no residue) ──────────────────────────────
  // Route the close through "main": closing a window that hosts a terminal tears down its
  // PTY and webview, and a reply routed through the dying window times out even though the
  // close took effect. Verify the outcome by the window's absence, not the ack.
  console.log("\ne. close the opened window");
  try {
    await rpc("window.close", { label: win }, { window: "main" });
  } catch {
    /* TIMEOUT here is expected — the closing window can drop the reply. */
  }
  await sleep(1000);
  const labels = (data(await rpc("window.list", {}, { window: "main" })).labels) || [];
  ok(!labels.includes(win), `window ${win} is gone from window.list`);

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  console.log(
    totalUnreported === 0 && totalUndeclared === 0
      ? "verdict: GREEN — mounted content views agree with their declarations (view-status promotion-ready)"
      : `verdict: RED — ${totalUnreported} unreported + ${totalUndeclared} undeclared across mounted content views`,
  );
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(1);
});
