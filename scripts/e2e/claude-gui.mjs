#!/usr/bin/env node
// soksak-plugin-claude-gui E2E — 멱등 시나리오 드라이버.
//
// soksak 소켓(JSON-RPC)에 붙어 실제 앱을 구동하고, 플러그인이 노출하는 결정적
// introspection 명령(plugin.soksak-plugin-claude-gui.state/send/queue)으로 단언한다.
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
const PLUGIN = "soksak-plugin-claude-gui";
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

// dir 의 활성 세션(지상 진실) = newest mtime jsonl. GUI 의 state.session 과 비교할 오라클.
const expandTilde = (p) =>
  p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
function newestJsonl(dir) {
  const d = expandTilde(dir);
  let best = null;
  let bestM = -1;
  for (const f of fs.readdirSync(d)) {
    if (!/^[0-9a-f-]{36}\.jsonl$/.test(f)) continue;
    const m = fs.statSync(path.join(d, f)).mtimeMs;
    if (m > bestM) {
      bestM = m;
      best = f.replace(/\.jsonl$/, "");
    }
  }
  return best;
}

// 세션 트랜스크립트에 assistant 턴이 기록됐나(= 그 Q&A 가 완료됨). claude 는 턴 완료 시
// jsonl 에 assistant 엔트리를 쓴다 → 버퍼 시그니처보다 안정적인 완료 신호.
function sessionHasAssistant(dir, sid) {
  if (!sid) return false;
  try {
    const txt = fs.readFileSync(path.join(expandTilde(dir), sid + ".jsonl"), "utf8");
    return /"type"\s*:\s*"assistant"/.test(txt);
  } catch {
    return false;
  }
}

// 세션 트랜스크립트에 특정 텍스트가 들어왔나 — GUI 입력이 그 세션에 도달했는지 검증용.
function sessionHasText(dir, sid, needle) {
  if (!sid) return false;
  try {
    return fs.readFileSync(path.join(expandTilde(dir), sid + ".jsonl"), "utf8").includes(needle);
  } catch {
    return false;
  }
}

// 질문 1개를 깨끗이 제출하고 turn 완료까지 대기. 반환 = 완료 여부.
// 완료 검증 = 현재 세션 트랜스크립트에 assistant 턴 등장(버퍼 "esc to interrupt" 는 응답이
// 빠르면 폴링이 놓쳐 불안정). ESC 중단 안 함 — "오렌지.../clear" 붙음 오염의 원인이었다.
async function askOne(pane, dir, q) {
  await send(pane, q + CR);
  return await waitFor(async () => {
    const sid = (await pcmd("state", { paneId: pane })).session;
    return sessionHasAssistant(dir, sid);
  }, 90000, "Q&A 완료(assistant 턴)")
    .then(() => true)
    .catch(() => false);
}

// 깨끗한 새 세션 경계: /clear → settle. 직전 askOne 이 turn 완료를 보장하므로 붙음 없음.
async function newSession(pane) {
  await idle(pane);
  await send(pane, "/clear" + CR);
  await sleep(1500);
  await idle(pane);
}

// 6. /resume 세션 동기화 — TUI 에서 다른 세션을 고르면 GUI 도 그 세션으로 전환되어야 한다.
//    버그: 옛 신호 session-env 가 resume 를 놓쳐 옛 세션(혹은 phantom)에 고정.
//    상호작용(실측 확정): '/resume'+Enter 로 피커를 연 뒤 곧바로 Enter 는 "resume 취소"다.
//    조금 기다렸다가 아래 한칸(DOWN) → Enter 해야 항목이 선택된다.
//    통제(선배 지침): /clear 로 알려진 Q&A 세션 2개(S1·S2)를 먼저 만들고 빈 현재 세션 A 에서
//    시작 → DOWN+Enter 가 결정적으로 알려진 세션을 고른다. 그래서 "전환됐다"를 신뢰할 수 있다.
//    단언(반박 불가): resume 후 state.session == dir 의 newest jsonl(=실제 활성) && 그게 우리가
//    만든 S1/S2 중 하나 && 현재 A 와 다름. 옛 코드(phantom)면 session != newest → 실패(RED).
//    멱등: 매 실행 자체 fixture 생성, garbage 누적 없음. 피커 미등장/취소 반복은 SKIP.
async function scResumeSync(pane) {
  console.log("[6] /resume 세션 동기화 (통제 fixture)");
  await idle(pane);
  await pcmd("open", { paneId: pane });
  let dir = null;
  for (let i = 0; i < 20; i++) {
    dir = (await pcmd("state", { paneId: pane })).dir;
    if (dir) break;
    await sleep(400);
  }
  if (!dir) {
    warnSkip("dir 미식별 — claude 미실행/미인증?");
    return;
  }

  // 알려진 Q&A 세션 2개 생성 — 검증된 상태 전이로 붙음·오염 없이 distinct.
  // 각 세션 uuid = Q&A 완료 후 state.session(= 그 세션의 newest jsonl). /clear 경계로 분리.
  await newSession(pane);
  const ok1 = await askOne(pane, dir, "오렌지는 무슨 색? 한 단어로만 답해");
  const S1 = (await pcmd("state", { paneId: pane })).session;
  await newSession(pane);
  const ok2 = await askOne(pane, dir, "포도는 무슨 색? 한 단어로만 답해");
  const S2 = (await pcmd("state", { paneId: pane })).session;
  await newSession(pane); // 빈 현재 세션 A
  const A = (await pcmd("state", { paneId: pane })).session;
  const known = [...new Set([S1, S2].filter(Boolean))]; // distinct 알려진 세션
  if (!ok1 || !ok2 || known.length < 2 || !A || known.includes(A)) {
    warnSkip(`fixture 생성 실패 — S1=${S1?.slice(0, 8)} S2=${S2?.slice(0, 8)} A=${A?.slice(0, 8)} (응답 ${ok1}/${ok2})`);
    return;
  }
  ok(true, `통제 fixture — 알려진 세션 ${known.map((s) => s.slice(0, 8)).join(",")} · 현재A=${A.slice(0, 8)}`);

  const DOWN = ESC + "[B";
  let switched = false;
  let B = A;
  let oracle = null;
  let pickerSeen = false;
  const TRIES = 3;
  for (let a = 1; a <= TRIES && !switched; a++) {
    await idle(pane);
    await send(pane, "/resume" + CR);
    let picker = false;
    try {
      await waitFor(
        async () => /Resume session|Esc to cancel/i.test(await readBuf(pane, 40)),
        9000,
        "resume 피커",
      );
      picker = true;
      pickerSeen = true;
    } catch {
      /* 미등장 */
    }
    if (!picker) {
      console.log(`    시도 ${a}/${TRIES}: 피커 미등장 → 재시도`);
      continue;
    }
    if (a === 1) await shot("6-resume-picker");
    // 조금 기다렸다가(즉시 Enter=취소 회피) → 아래 한칸 → Enter.
    await sleep(1800);
    await send(pane, DOWN);
    await sleep(450);
    await send(pane, CR);
    // 단언: GUI == 활성 jsonl && 그게 우리가 만든 알려진 세션 && 현재 A 와 다름.
    try {
      await waitFor(async () => {
        oracle = newestJsonl(dir);
        B = (await pcmd("state", { paneId: pane })).session;
        return oracle && known.includes(oracle) && B === oracle && oracle !== A;
      }, 20000, "알려진 세션 전환+동기화");
      switched = true;
    } catch {
      const buf = await readBuf(pane, 8);
      const why = /취소하셨|Resume cancelled/i.test(buf)
        ? "resume 취소됨(타이밍)"
        : `미동기화(B=${B?.slice(0, 8)} oracle=${oracle?.slice(0, 8)})`;
      console.log(`    시도 ${a}/${TRIES}: ${why} → 재시도`);
    }
  }

  if (switched) {
    ok(known.includes(oracle), `알려진 세션으로 resume됨 — ${oracle === S1 ? "S1(오렌지)" : "S2(포도)"} ${oracle.slice(0, 8)}`);
    ok(B === oracle, `GUI 세션 == 실제 활성(dir newest jsonl) — ${B.slice(0, 8)}`);
    ok(B !== A, `현재(${A.slice(0, 8)})와 다른 세션으로 전환`);
    const s2 = await pcmd("state", { paneId: pane });
    ok(s2.bubbles > 0, `전환 세션 대화 재렌더 — bubbles=${s2.bubbles}`);
    await shot("6-resume-synced");

    // 완결: resume 후 실제 GUI 입력창에 타이핑+Enter 가 그 세션으로 들어가는지(진짜 입력 경로).
    // focus(화면 이동=입력창 포커스) → type(textarea 값+진짜 Enter keydown → GUI send 핸들러).
    // claude → resumed 세션 B 트랜스크립트에 그 텍스트가 도달해야.
    await idle(pane);
    const q3 = `레몬은 무슨 색? 한 단어로만 답해 (resume-input ${RUN})`;
    const foc = await pcmd("focus", { paneId: pane }); // GUI 로 화면 이동(입력창 포커스)
    ok(foc.focused === true, `GUI 입력창 포커스됨(화면 이동)`);
    const typeRes = await pcmd("type", { paneId: pane, text: q3 }); // 입력창에 실제 타이핑+Enter
    const inputReached = await waitFor(
      async () => sessionHasText(dir, B, `resume-input ${RUN}`),
      40000,
      "GUI 입력창 입력이 resumed 세션 도달",
    )
      .then(() => true)
      .catch(() => false);
    ok(inputReached, `GUI 입력창 입력이 resumed 세션 ${B.slice(0, 8)} 으로 전송됨(end-to-end)`);
    if (inputReached) {
      // GUI 가 그 입력을 같은 세션에 렌더(전환 없이 유지) — watcher 렌더 지연이 있으니 폴링.
      let s3 = s2;
      const grew = await waitFor(async () => {
        s3 = await pcmd("state", { paneId: pane });
        return s3.session === B && s3.bubbles > s2.bubbles;
      }, 30000, "입력 렌더(bubbles 증가)")
        .then(() => true)
        .catch(() => false);
      ok(grew, `입력 후 같은 세션 유지+GUI 렌더 — bubbles ${s2.bubbles}→${s3.bubbles}`);
      await shot("6-resume-input");
    } else {
      console.log(`    type 응답: ${JSON.stringify(typeRes?.queue)}`);
    }
  } else if (!pickerSeen) {
    warnSkip("resume 피커 미등장(TUI 타이밍) — 동기화 단언 불가");
  } else {
    ok(false, `resume 선택 후 GUI 가 알려진 세션 미추적(${TRIES}회) — 현재 A=${A.slice(0, 8)} 고정`);
    await shot("6-resume-fail");
  }
  await idle(pane);
}

// ── 러너 ──────────────────────────────────────────────────────────────────────
async function main() {
  await connect();
  const pane = await activePane(process.argv[2]);
  console.log(`E2E claude-gui — pane=${pane} · shots=${SHOTS}\n`);
  await ensureClaude(pane);
  const ALL = [
    scQueueModalHold,
    scDrainL3,
    scPersistence,
    scConversationRender,
    scLiveBand,
    scResumeSync,
  ];
  // E2E_ONLY=scResumeSync 처럼 일부만 실행(RED/GREEN 격리용). 미지정 시 전체.
  const only = (process.env.E2E_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const run = only.length ? ALL.filter((sc) => only.includes(sc.name)) : ALL;
  for (const sc of run) {
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
