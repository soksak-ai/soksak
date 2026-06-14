#!/usr/bin/env node
// soksak-claude-gui E2E — 멱등 시나리오 드라이버.
//
// soksak 소켓(JSON-RPC)에 붙어 실제 앱을 구동하고, 플러그인이 노출하는 결정적
// introspection 명령(plugin.soksak-claude-gui.state/send/queue)으로 단언한다.
// DOM 은 소켓이 못 보므로 plugin.*.state 가 {open,bubbles,live,queue,classify,session}
// 을 돌려준다. 시각 확인용 스냅샷도 dir 에 남긴다.
//
// 전제: 대상 pane 에 claude 가 실행 중(없으면 자동 시작 시도). claude 인증은 사용자 환경.
//
// 사용:
//   SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/claude-gui.mjs [paneId]
//   (paneId 생략 = 활성 프로젝트의 첫 터미널 pane)
//
// 종료코드: 0 = 결정적 시나리오 전부 PASS. 1 = 실패. claude 응답 의존(드레인/라이브)은
// 타임아웃 시 SKIP(경고)로 처리해 인증/네트워크 환경에서도 결정적 부분은 검증된다.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const PLUGIN = "soksak-claude-gui";
const SHOTS = process.env.E2E_SHOTS || "/tmp/sok-e2e-claude-gui";
fs.mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36); // 실행별 고유 태그(이전 실행 잔여와 격리)
const ESC = ""; // 다이얼로그/응답 닫기·인터럽트(빈 문자열 아님!)
const CR = "\r";

// ── 소켓 RPC ──────────────────────────────────────────────────────────────────
let sock;
let seq = 0;
const pending = new Map();
let rbuf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", () => resolve());
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
function rpc(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params }) + "\n");
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
    if (await fn()) return true;
    await sleep(300);
  }
  throw new Error(`waitFor 타임아웃(${label})`);
}

// ── 플러그인/터미널 헬퍼 ──────────────────────────────────────────────────────
const pcmd = (name, params) => rpc(`plugin.${PLUGIN}.${name}`, params);
const readBuf = async (pane, lines) =>
  (await rpc("term.read", { pane, lines })).text || "";
const send = (pane, text) => rpc("term.send", { pane, text });
const shot = async (name) => {
  const p = path.join(SHOTS, `${name}.png`);
  await rpc("window.snapshot", { path: p }).catch(() => {});
  return p;
};

// ── 단언/리포트 ───────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
let skip = 0;
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
function warnSkip(msg) {
  skip++;
  console.log(`  ⚠ SKIP ${msg}`);
}

// ── setup ─────────────────────────────────────────────────────────────────────
async function activePane(arg) {
  if (arg) return arg;
  const t = await rpc("state.tree");
  const proj = (t.projects || []).find((p) => p.active) || t.projects[0];
  const content = proj.contents.find((c) => c.active) || proj.contents[0];
  for (const g of content.panels || [])
    for (const v of g.views || [])
      if (v.kind === "terminal") return v.focusedPaneId || v.id;
  throw new Error("터미널 pane 없음");
}
const CLAUDE_RE = /esc to interrupt|auto mode on|\? for shortcuts|Claude Code|Welcome back/i;
async function ensureClaude(pane) {
  if (CLAUDE_RE.test(await readBuf(pane, 40))) return;
  await send(pane, "claude" + CR);
  await waitFor(
    async () => CLAUDE_RE.test(await readBuf(pane, 40)),
    25000,
    "claude 부팅",
  );
  await sleep(1000);
}
// claude 를 깨끗한 idle 프롬프트로 — 응답중이면 인터럽트, 다이얼로그면 닫기. 견고(폴링).
async function idle(pane) {
  for (let i = 0; i < 6; i++) {
    const buf = await readBuf(pane, 30);
    if (!/esc to interrupt|esc to (cancel|go ?back|close|dismiss|exit)/i.test(buf)) {
      await sleep(300);
      return;
    }
    await send(pane, ESC);
    await sleep(700);
  }
}
// /status(모달)을 확실히 연다 — classify=modal 될 때까지 대기. setup 실패면 throw.
async function ensureModal(pane) {
  await idle(pane);
  await send(pane, "/status" + CR);
  await waitFor(
    async () => (await pcmd("state", { paneId: pane })).classify === "modal",
    9000,
    "/status 열림(classify=modal)",
  );
}

// ── 시나리오 ──────────────────────────────────────────────────────────────────
// 1. 모달(/status) 중 입력 → held(다이얼로그 대기), claude 에 미주입. 결정적.
async function scQueueModalHold(pane) {
  console.log("[1] 입력 큐 — 모달 중 보류");
  await pcmd("close", { paneId: pane }).catch(() => {});
  await ensureModal(pane);
  await pcmd("open", { paneId: pane });
  await sleep(400);
  const s0 = await pcmd("state", { paneId: pane });
  ok(s0.classify === "modal", `classify=modal (실제 /status 버퍼) — got ${s0.classify}`);
  const t1 = `e2eq1-${RUN}`;
  const t2 = `e2eq2-${RUN}`;
  const r1 = await pcmd("send", { paneId: pane, text: t1 });
  ok(
    r1.queue?.length === 1 && r1.queue[0].state === "held" && r1.queue[0].reason === "modal",
    `q1 held+modal — got ${JSON.stringify(r1.queue)}`,
  );
  const r2 = await pcmd("send", { paneId: pane, text: t2 });
  ok(r2.queue?.length === 2, `q2 → 큐 2항목 — got ${r2.queue?.length}`);
  const buf = await readBuf(pane, 30);
  ok(!buf.includes(t1) && !buf.includes(t2), "claude 버퍼에 미주입(보류 성공)");
  await shot("1-modal-hold");
}

// 2. 모달 닫힘 → FIFO 드레인 → L3(claude 처리) 후 큐 제거. claude 응답 의존 → 타임아웃 SKIP.
async function scDrainL3(pane) {
  console.log("[2] FIFO 드레인 + L3 제거");
  await idle(pane); // /status 닫기(응답중이면 인터럽트)
  try {
    await waitFor(
      async () => (await pcmd("queue", { paneId: pane })).queue.length === 0,
      45000,
      "큐 비워짐(L3)",
    );
    ok(true, "모달 닫히니 드레인 → 전부 L3 제거(큐 빔)");
    await shot("2-drained");
  } catch {
    const q = await pcmd("queue", { paneId: pane });
    warnSkip(`드레인 미완(claude 응답 지연/인증?) — 잔여 ${JSON.stringify(q.queue)}`);
  }
}

// 3. persistence — 모달 중 큐잉 → GUI 닫기 → 재오픈 → 항목 보존. 결정적.
async function scPersistence(pane) {
  console.log("[3] persistence — 닫았다 열어도 보존");
  await pcmd("close", { paneId: pane }).catch(() => {});
  await ensureModal(pane);
  await pcmd("open", { paneId: pane });
  await sleep(400);
  await pcmd("send", { paneId: pane, text: "e2e-persist" });
  const before = await pcmd("queue", { paneId: pane });
  ok(before.queue.some((i) => i.text === "e2e-persist"), "큐잉됨");
  await pcmd("close", { paneId: pane });
  await sleep(500);
  await pcmd("open", { paneId: pane });
  await sleep(500);
  const after = await pcmd("state", { paneId: pane });
  ok(
    after.queue.some((i) => i.text === "e2e-persist"),
    `재오픈 후 보존 — got ${JSON.stringify(after.queue)}`,
  );
  await shot("3-persist");
  await idle(pane); // 정리: /status 닫기(드레인)
}

// 4. 대화 렌더 — claude 히스토리가 있으면 버블이 렌더된다. 결정적(히스토리 전제).
async function scConversationRender(pane) {
  console.log("[4] 대화 렌더 — 버블");
  await pcmd("open", { paneId: pane });
  await sleep(800);
  const s = await pcmd("state", { paneId: pane });
  ok(s.session != null, `세션 식별됨 — ${s.session}`);
  if (s.bubbles > 0) ok(true, `대화 버블 ${s.bubbles}개 렌더`);
  else warnSkip("버블 0 — 이 세션에 대화 기록이 아직 없음");
  await shot("4-render");
}

// 5. 라이브 응답 밴드 — 응답 중 .cg-live 표시. claude 응답 시작/시간이 불가측(LLM thinking·
//    컨디션 의존, 실측상 0~수십초 지연)이라 결정적 단언 불가 → 재시도 + 안전대기 best-effort.
//    파서 로직(parseLiveResponse)은 단위테스트로 검증됨. 응답중 시그니처 자체는 실측 캡처 필요.
async function scLiveBand(pane) {
  console.log("[5] 라이브 응답 밴드 (claude 응답 의존 — 재시도+안전대기)");
  await pcmd("open", { paneId: pane });
  let caught = false;
  const TRIES = Number(process.env.E2E_LIVE_TRIES || 2);
  const WAIT = Number(process.env.E2E_LIVE_WAIT_MS || 35000);
  for (let a = 1; a <= TRIES && !caught; a++) {
    await idle(pane);
    await send(pane, `한 단어로만 답해 색깔 하나${CR}`);
    const t0 = Date.now(); // 안전대기 — 응답 시작~종료까지 촘촘 폴(250ms)
    while (Date.now() - t0 < WAIT) {
      if ((await pcmd("state", { paneId: pane })).live) {
        caught = true;
        break;
      }
      await sleep(250);
    }
    if (!caught) console.log(`    시도 ${a}/${TRIES} 미포착 → 재시도`);
  }
  if (caught) {
    ok(true, "응답 중 .cg-live 밴드 표시됨");
    await shot("5-live");
  } else {
    warnSkip(
      "라이브 밴드 미포착 — claude 응답 시작/타이밍 불가측. 파서는 단위테스트 통과; " +
        "응답중 시그니처는 실측 캡처로 확정 필요(follow-up)",
    );
  }
}

// ── 러너 ──────────────────────────────────────────────────────────────────────
async function main() {
  await connect();
  const pane = await activePane(process.argv[2]);
  console.log(`E2E claude-gui — pane=${pane} · shots=${SHOTS}\n`);
  await ensureClaude(pane);
  for (const sc of [
    scQueueModalHold,
    scDrainL3,
    scPersistence,
    scConversationRender,
    scLiveBand,
  ]) {
    try {
      await sc(pane);
    } catch (e) {
      fail++;
      console.log(`  ✗ 시나리오 예외: ${e.message}`);
    }
  }
  await pcmd("close", { paneId: pane }).catch(() => {}); // teardown
  console.log(`\n결과: PASS ${pass} · FAIL ${fail} · SKIP ${skip} · shots → ${SHOTS}`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("E2E 실패:", e.message);
  process.exit(2);
});
