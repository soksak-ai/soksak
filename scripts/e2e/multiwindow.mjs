// 멀티 윈도우 E2E — 소켓으로 새 창을 만들고 라우팅(활성/명시 타겟)·창별 독립을 자가 검증한다.
// 멱등: 만든 창은 끝에 닫는다. 시각(브라우저 hole-punch)은 별도(snapshot label 후속).
//
// 실행:
//   SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/multiwindow.mjs
//
// 검증:
//   1) window.open → 새 창 label, window.list 가 +1
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
    // 응답 봉투(MESSAGE-PROTOCOL): 기계 페이로드는 data 에 중첩 — 헬퍼에서 평탄화한다.
    pending.set(id, (resp) =>
      resolve(
        resp && typeof resp === "object" && resp.data && typeof resp.data === "object"
          ? { ...resp.data, ...Object.fromEntries(Object.entries(resp).filter(([k]) => k !== "data")) }
          : resp,
      ),
    );
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

  ok((await listLabels()).includes("main"), "초기 창 목록에 컨트롤 플레인(main) 포함");

  // 잔재 청소(멱등) — 이전 실행이 남긴 이 하니스의 창을 먼저 닫는다.
  for (const l of await listLabels()) {
    if (!l.startsWith("w-")) continue;
    try {
      const tr = await rpc("state.tree", {}, l);
      if ((tr.projects || []).some((p) => String(p.root || "").includes("soksak-e2e-mw") ||
                                          String(p.root || "").includes("soksak-e2e-p6"))) {
        await rpc("window.close", { label: l });
        await sleep(400);
      }
    } catch { /* 응답 없는 창은 건드리지 않는다 */ }
  }

  // 워크스페이스 기준 창 — main 은 컨트롤 플레인(NAMING 4b)이라 워크스페이스 시나리오의
  // 기준은 전용 홈 창이다.
  const fs0 = await import("node:fs");
  const home = path.join(os.tmpdir(), "soksak-e2e-mw-home");
  fs0.mkdirSync(home, { recursive: true });
  const rHome = await rpc("window.open", { root: home });
  const base = rHome.label || rHome.existingWindow;
  ok(typeof base === "string" && base.startsWith("w-"), `홈 워크스페이스 창 → ${base}`);
  await waitFor(
    async () => (await rpc("state.tree", {}, base)).ok !== false,
    12000,
    "홈 창 부트",
  );
  const before = await listLabels();

  // 1) 새 창(빈 창은 없다 — root 필수)
  const rootA = path.join(os.tmpdir(), "soksak-e2e-mw-a");
  fs0.mkdirSync(rootA, { recursive: true });
  const created = await rpc("window.open", { root: rootA });
  const win = created.label;
  ok(typeof win === "string" && win.startsWith("w-"), `window.open → ${win}`);

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
  const bad = await rpc("state.tree", {}, "w-nope-9999");
  ok(bad.ok === false && bad.code === "WINDOW_NOT_FOUND", "없는 창 타겟 → WINDOW_NOT_FOUND");

  // 5) 창별 독립: win 에 시트 추가 → 홈 창 불변 + 두 창 상태 구분
  const baseBefore = await tree(base);
  await rpc("sheet.create", { program: "terminal" }, win);
  await sleep(400);
  const baseAfter = await tree(base);
  const winAfter = await tree(win);
  ok(baseBefore === baseAfter, "창별 독립: win 시트 추가가 홈 창에 안 번짐");
  ok(winAfter !== baseAfter, "win 과 홈 창이 독립 상태(다름)");

  // 4) 활성 추적: focus(win) → window 생략 = win, focus(base) → = base
  await rpc("window.focus", { label: win });
  await sleep(500); // 포커스 이벤트 → LAST_FOCUSED 갱신
  ok((await tree()) === winAfter, "활성 추적: focus(win) 후 window 생략 = win");
  await rpc("window.focus", { label: base });
  await sleep(500);
  ok((await tree()) === baseAfter, "활성 추적: focus(base) 후 window 생략 = base");

  // 6) 정리(멱등) — 창 닫기
  await rpc("window.close", { label: win });
  await sleep(400);
  const end = await listLabels();
  ok(!end.includes(win) && end.length === before.length, `window.close → 원복 (${end.join(",")})`);

  // 7) P6 전역 단일 오픈 — 같은 root 는 전 창 통틀어 1곳, 충돌은 소유 창 포커스,
  //    닫기/창 파괴는 점유를 해제한다(project_registry.rs 시행의 소켓 검증).
  {
    const fs = await import("node:fs");
    const root = path.join(os.tmpdir(), "soksak-e2e-p6");
    fs.mkdirSync(root, { recursive: true });

    const rootB = path.join(os.tmpdir(), "soksak-e2e-mw-b");
    fs.mkdirSync(rootB, { recursive: true });
    const win2 = (await rpc("window.open", { root: rootB })).label;
    await waitFor(
      async () => (await rpc("state.tree", {}, win2)).ok !== false,
      12000,
      "P6 창 부트",
    );

    const r1 = await rpc("project.open", { root }, base);
    ok(r1.ok === true && !!r1.projectId, `P6: 홈 창에서 열기 (${r1.projectId})`);

    const r2 = await rpc("project.open", { root }, win2);
    ok(
      r2.ok === true && r2.existingWindow === base && !r2.projectId,
      `P6: ${win2} 중복 열기 → existingWindow=${base}(새 탭 없음)`,
    );
    await sleep(500); // window_focus → LAST_FOCUSED 갱신
    ok((await tree()) === (await tree(base)), "P6: 충돌 시 소유 창(홈) 포커스");

    await rpc("project.close", { project: r1.projectId }, base);
    await sleep(300);
    const r3 = await rpc("project.open", { root }, win2);
    ok(r3.ok === true && !!r3.projectId, "P6: 홈에서 닫은 후(점유 해제) 다른 창 열기 성공");

    // 창 파괴 = 그 창 점유 전부 해제(release_window) — 닫고 홈에서 재열기.
    await rpc("window.close", { label: win2 });
    await sleep(500);
    const r4 = await rpc("project.open", { root }, base);
    ok(r4.ok === true && !!r4.projectId, "P6: 창 파괴 후 점유 해제 → 홈 재열기");
    await rpc("project.close", { project: r4.projectId }, base);
  }

  // 정리 — 홈 창과 recents 위생
  await rpc("window.close", { label: base });
  await sleep(400);
  for (const r of [home, path.join(os.tmpdir(), "soksak-e2e-mw-a"),
                   path.join(os.tmpdir(), "soksak-e2e-mw-b"),
                   path.join(os.tmpdir(), "soksak-e2e-p6")]) {
    await rpc("project.recent.remove", { root: r }, "main");
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E 실패:", e.message);
  process.exit(1);
});
