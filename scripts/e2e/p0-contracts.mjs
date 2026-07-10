#!/usr/bin/env node
// P0 socket-contract E2E — asserts the boot/version/discovery contract of a running
// app over SOKSAK_SOCKET (JSON-RPC, newline-framed). Six checks, all read-only against
// the store so the run is idempotent and opens no windows:
//   a. system.hello answers at the transport with the full negotiation payload.
//   b. a request declaring protocol 999 is refused with VERSION_SKEW — a directional
//      sentence (both version numbers + the stale side) and a data triple of numbers.
//   c. a legacy request (no protocol field) passes the gate and executes.
//   d. system.hello is discoverable in the state.commands catalog.
//   e. window.snapshot captures a live render (size reported for eyeball sizing).
// The corrupt-DB backup-ring recovery contract is a separate lifecycle scenario
// (db-recovery.sh) because it restarts the app.
//
// Run: SOKSAK_SOCKET=~/.soksak-debug/com.soksak.debug.sock node scripts/e2e/p0-contracts.mjs
// Optional: P0_EXPECT_LANG=ko|en requires the skew sentence to render in that language;
//           unset accepts either shipped skeleton (but still fails on a raw/untranslated one).
//           P0_SNAPSHOT_PATH overrides where the render capture is written.
// Exit: 0=GREEN (every check passed), 1=RED.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");
const SNAPSHOT_PATH =
  process.env.P0_SNAPSHOT_PATH || path.join(os.tmpdir(), "soksak-p0-contracts-snapshot.png");
const EXPECT_LANG = process.env.P0_EXPECT_LANG || ""; // "", "ko", or "en"

// ── socket RPC (same framing as e2e-driver.mjs) ──────────────────────────────
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
// Returns the raw response envelope (no data flattening — the checks assert on the
// envelope shape itself: ok/code/message/data). `extra` merges top-level request
// fields such as `protocol`.
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

async function main() {
  await connect();
  console.log(`P0 socket-contract E2E\nsocket: ${SOCKET}\n`);

  // ── a. system.hello negotiation payload ────────────────────────────────────
  console.log("a. system.hello negotiation payload");
  const hello = await rpc("system.hello");
  ok(hello.ok === true, "hello ok:true");
  ok(Number.isInteger(hello.protocol), `protocol present (${hello.protocol})`);
  ok(Number.isInteger(hello.minClientProtocol), `minClientProtocol present (${hello.minClientProtocol})`);
  ok(typeof hello.appVersion === "string" && hello.appVersion.length > 0, `appVersion present (${hello.appVersion})`);
  ok(typeof hello.identity === "string" && hello.identity.length > 0, `identity present (${hello.identity})`);
  ok(Number.isInteger(hello.pid) && hello.pid > 0, `pid present (${hello.pid})`);
  ok(Number.isInteger(hello.startedAt) && hello.startedAt > 0, `startedAt present (${hello.startedAt})`);
  ok(
    Array.isArray(hello.capabilities) && hello.capabilities.includes("hello.v1"),
    `capabilities carries hello.v1 (${JSON.stringify(hello.capabilities)})`,
  );

  // ── b. VERSION_SKEW gate: protocol 999 ─────────────────────────────────────
  console.log("\nb. VERSION_SKEW gate (protocol 999)");
  const skew = await rpc("state.commands", {}, { protocol: 999 });
  ok(skew.ok === false, "skewed request refused (ok:false)");
  ok(skew.code === "VERSION_SKEW", `code VERSION_SKEW (${skew.code})`);
  const s = String(skew.message ?? "");
  ok(s.includes("999") && s.includes("1"), `sentence names both version numbers (${JSON.stringify(s)})`);
  const looksKo = s.includes("소켓 프로토콜") && s.includes("업데이트");
  const looksEn = s.includes("socket protocol") && s.includes("update");
  ok(looksKo || looksEn, "sentence is i18n-rendered, not raw");
  const lang = looksKo ? "ko" : looksEn ? "en" : "?";
  console.log(`    detected language: ${lang}`);
  if (EXPECT_LANG) ok(lang === EXPECT_LANG, `sentence renders in expected language ${EXPECT_LANG}`);
  const d = skew.data ?? {};
  ok(d.appProtocol === hello.protocol, `data.appProtocol == app protocol (${d.appProtocol})`);
  ok(Number.isInteger(d.minClientProtocol), `data.minClientProtocol present (${d.minClientProtocol})`);
  ok(d.clientProtocol === 999, `data.clientProtocol == 999 (${d.clientProtocol})`);

  // ── c. legacy quadrant: no protocol field passes ───────────────────────────
  console.log("\nc. legacy passthrough (no protocol field)");
  const legacy = await rpc("activity.recent", { limit: 1 });
  ok(legacy.ok === true, `legacy request executes (ok:true, code ${legacy.code})`);
  ok(legacy.code !== "VERSION_SKEW", "legacy request not skew-gated");

  // ── d. hello discoverability in the command catalog ────────────────────────
  console.log("\nd. system.hello discoverable in state.commands");
  const cmds = await rpc("state.commands");
  const list = (cmds.data && cmds.data.commands) || cmds.commands || [];
  const names = new Set(list.map((c) => c && c.name));
  ok(names.has("system.hello"), `catalog carries system.hello (of ${names.size} commands)`);

  // ── e. live render snapshot ────────────────────────────────────────────────
  console.log("\ne. window.snapshot live render");
  try {
    fs.rmSync(SNAPSHOT_PATH, { force: true });
  } catch {}
  const snap = await rpc("window.snapshot", { path: SNAPSHOT_PATH });
  ok(snap.ok === true, `snapshot ok:true (code ${snap.code})`);
  const exists = fs.existsSync(SNAPSHOT_PATH);
  ok(exists, `snapshot file written: ${SNAPSHOT_PATH}`);
  if (exists) {
    const bytes = fs.statSync(SNAPSHOT_PATH).size;
    console.log(`    snapshot size: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB) — ~41KB=blank, ~190KB+=real render`);
    ok(bytes > 60_000, `snapshot is not a blank frame (>60KB)`);
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(1);
});
