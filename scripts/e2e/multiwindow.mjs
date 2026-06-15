// 멀티 윈도우 E2E — 소켓으로 새 창을 만들고 라우팅(활성/명시 타겟)·창별 독립을 자가 검증한다.
// 멱등: 만든 창은 끝에 닫는다. 시각(브라우저 hole-punch)은 별도(snapshot label 후속).
//
// 실행:
//   SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/multiwindow.mjs
//
// 검증:
//   1) window.new → 새 창 label, window.list 가 +1
//   2) 명시 타겟: state.tree {window:win} 이 그 창 상태 반환(emit_to 라우팅)
//   3) WINDOW_NOT_FOUND: 없는 창 타겟은 거부
//   4) 활성 추적: window.focus(win) 후 window 생략 명령이 win 으로 라우팅
//   5) 창별 독립: win 에서 콘텐츠 추가가 main 에 안 번짐
//   6) window.close → window.list 가 -1(멱등 정리)

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");

let sock;
let seq = 0;
const pending = new Map();
let rbuf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      rbuf += d.toString("utf8");
      let i;
      while ((i = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, i);
        rbuf = rbuf.slice(i + 1);
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
// window 는 top-level(Request.window) — params 가 아니라 별도 필드(소켓 라우팅 타겟).
function rpc(method, params = {}, window) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const req = { id, method, params };
    if (window) req.window = window;
    sock.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 15000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`waitFor 타임아웃(${label})`);
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

async function listLabels() {
  const r = await rpc("window.list");
  return r.labels || [];
}
// 창 상태 지문(id·ok echo 제외 — 매 호출 달라지므로). window 생략 시 활성 창.
async function tree(window) {
  const r = await rpc("state.tree", {}, window);
  return JSON.stringify({ a: r.activeProjectId, p: r.projects });
}

async function main() {
  await connect();
  console.log("멀티 윈도우 E2E");

  const before = await listLabels();
  ok(before.includes("main"), `초기 창 목록에 main 포함 (${before.join(",")})`);

  // 1) 새 창
  const created = await rpc("window.new");
  const win = created.label;
  ok(typeof win === "string" && win.startsWith("win-"), `window.new → ${win}`);

  // 2) 부트 대기 + 명시 타겟 라우팅(win 의 state.tree 가 응답)
  await waitFor(
    async () => {
      const r = await rpc("state.tree", {}, win);
      return r.ok !== false;
    },
    12000,
    "새 창 부트(state.tree 응답)",
  );
  ok(true, `명시 타겟 라우팅: state.tree {window:${win}} 응답`);

  const after = await listLabels();
  ok(after.includes(win) && after.length === before.length + 1, `window.list +1 (${after.join(",")})`);

  // 3) 없는 창 → WINDOW_NOT_FOUND
  const bad = await rpc("state.tree", {}, "win-nope-9999");
  ok(bad.ok === false && bad.code === "WINDOW_NOT_FOUND", "없는 창 타겟 → WINDOW_NOT_FOUND");

  // 5) 창별 독립: win 에 콘텐츠 추가 → main 불변 + win/main 상태 구분
  const mainBefore = await tree("main");
  await rpc("content.create", { program: "terminal" }, win);
  await sleep(400);
  const mainAfter = await tree("main");
  const winAfter = await tree(win);
  ok(mainBefore === mainAfter, "창별 독립: win 콘텐츠 추가가 main 에 안 번짐");
  ok(winAfter !== mainAfter, "win 과 main 이 독립 상태(다름)");

  // 4) 활성 추적: focus(win) → window 생략 = win, focus(main) → = main
  await rpc("window.focus", { label: win });
  await sleep(500); // 포커스 이벤트 → LAST_FOCUSED 갱신
  ok((await tree()) === winAfter, "활성 추적: focus(win) 후 window 생략 = win");
  await rpc("window.focus", { label: "main" });
  await sleep(500);
  ok((await tree()) === mainAfter, "활성 추적: focus(main) 후 window 생략 = main");

  // 6) 정리(멱등) — 창 닫기
  await rpc("window.close", { label: win });
  await sleep(400);
  const end = await listLabels();
  ok(!end.includes(win) && end.length === before.length, `window.close → 원복 (${end.join(",")})`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E 실패:", e.message);
  process.exit(1);
});
