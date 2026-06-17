#!/usr/bin/env node
// soksak-plugin-mailbox E2E — 멱등 시나리오 드라이버.
//
// 소켓(JSON-RPC)으로 실제 앱을 구동하고, 메일함 커맨드 + 코어 data.*/turn.* 로 단언한다.
// 합성 스코프(e2e-mailbox-<run>)를 써서 실제 프로젝트 데이터와 완전 격리 — clobber 없음.
//
// 전제: make dev(plugins/ 자동 dev-load, dev 소스=동의 면제). Rust data 모듈 포함 빌드.
// 사용: SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/mailbox.mjs
// 종료코드: 0 = 전부 PASS, 1 = FAIL.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SOCKET =
  process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const PLUGIN = "soksak-plugin-mailbox";
const PLUGIN_DIR = path.resolve("plugins/soksak-plugin-mailbox");
const RUN = Date.now().toString(36);
const SCOPE = `e2e-mailbox-${RUN}`; // 합성 root(격리) — 메일함은 임의 scope 문자열을 받는다

// ── 소켓 RPC ──
let sock, seq = 0;
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
        if (p) { pending.delete(msg.id); p(msg); }
      }
    });
  });
}
function rpc(method, params = {}, opts = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const req = { id, method, params, ...opts };
    sock.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`TIMEOUT ${method}`)); }
    }, 15000);
  });
}
const m = (name, params, opts) => rpc(`plugin.${PLUGIN}.${name}`, params, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 새 창 준비 대기 — 그 창에 라우팅한 state.context 가 ok 일 때까지 폴링(프론트 부팅 ~1-2s).
async function waitWindowReady(label, tries = 25) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rpc("state.context", {}, { window: label });
      if (r.ok) return true;
    } catch { /* 아직 미준비 */ }
    await sleep(300);
  }
  return false;
}

// ── 단언 ──
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`); }
}
function section(name) { console.log(`\n[${name}]`); }
const titles = (r) => (r.messages || []).map((x) => x.title);

async function main() {
  await connect();
  console.log(`소켓: ${SOCKET}\n스코프(격리): ${SCOPE}`);

  // ── setup: 최신 main.js 재적재 + 활성(dev 소스=동의 면제) ──
  section("setup");
  await rpc("plugin.disable", { id: PLUGIN }).catch(() => {});
  const loaded = await rpc("plugin.dev.load", { path: PLUGIN_DIR });
  ok(loaded.ok, "plugin.dev.load(최신 main.js)");
  const enabled = await rpc("plugin.enable", { id: PLUGIN });
  ok(enabled.ok && enabled.status === "enabled", "plugin.enable(dev 동의 면제)");
  await m("clear", { scope: SCOPE }); // 깨끗한 시작(멱등)

  // ── R1: send → list 왕복 ──
  section("R1 send→list");
  const sent = await m("send", {
    title: "빌드 완료 E2E", body: "성공", type: "push", pushType: "alert", to: SCOPE,
  });
  ok(sent.ok && typeof sent.messageId === "string", "send(push) → messageId 반환");
  ok(sent.scope === SCOPE, "scope = root(합성)");
  const MID = sent.messageId;
  const l1 = await m("list", { scope: SCOPE });
  ok(l1.ok && l1.messages.length === 1, "list → 1건");
  ok(l1.messages[0].id === MID && l1.messages[0].read === false, "목록 항목 = 보낸 메시지(unread)");
  ok(l1.messages[0].icon === "⚠️" && l1.messages[0].sound === "alert", "푸시타입(alert) 기본 icon/sound 해석");

  // ── R2: CJK 전문검색 ──
  section("R2 CJK 검색");
  ok((await m("search", { query: "빌드 완료", scope: SCOPE })).messages.length === 1, "trigram(≥3): '빌드 완료' 적중");
  ok((await m("search", { query: "완료", scope: SCOPE })).messages.length === 1, "LIKE 폴백(2자): '완료' 적중");
  ok((await m("search", { query: "존재안함xyz", scope: SCOPE })).messages.length === 0, "없는 검색어 → 0건");

  // ── R3: get ──
  section("R3 get");
  const got = await m("get", { id: MID, scope: SCOPE });
  ok(got.ok && got.message.title === "빌드 완료 E2E", "get → 동일 메시지");

  // ── R4: mark-read → unread 감소 ──
  section("R4 mark-read");
  const mr = await m("mark-read", { id: MID, scope: SCOPE });
  ok(mr.ok && mr.marked === 1, "mark-read → marked 1");
  const unread = await rpc("data.count", { ns: PLUGIN, coll: "messages", scope: SCOPE, where: { read: false } });
  ok(unread.ok && unread.count === 0, "코어 data.count unread = 0");

  // ── R5: 자동 구독(turn.ended → 자동 메시지) ──
  section("R5 self-subscribe");
  ok((await m("subscribe", { scope: SCOPE, source: "shell" })).ok, "subscribe(shell)");
  ok((await m("subscriptions", {})).subscriptions.some((s) => s.scope === SCOPE), "subscriptions 에 등재");
  await rpc("turn.signal", { source: "shell", root: SCOPE, command: "git status" });
  await sleep(400);
  const afterTurn = await m("list", { scope: SCOPE });
  const turnMsg = afterTurn.messages.find((x) => x.title.includes("턴 종료"));
  ok(!!turnMsg, "turn.signal → '턴 종료' 자동 메시지 생성");
  ok(turnMsg && typeof turnMsg.body === "string" && turnMsg.body.includes("git status"),
    "자동 메시지 본문 = 끝난 명령(enrich, pane id 아님)");
  ok((await m("unsubscribe", { scope: SCOPE })).ok, "unsubscribe");
  // 디바운스: 구독 해제 후 turn.signal 은 메시지 안 만든다.
  const before = (await m("list", { scope: SCOPE })).messages.length;
  await rpc("turn.signal", { source: "shell", root: SCOPE });
  await sleep(400);
  ok((await m("list", { scope: SCOPE })).messages.length === before, "구독 해제 후 turn.signal 무시");

  // ── R6: 딥링크 타깃(open) ──
  section("R6 deep-link open");
  const s2 = await m("send", { title: "딥링크 대상", type: "push", to: SCOPE });
  const opened = await m("open", { id: s2.messageId, root: SCOPE });
  ok(opened.ok, "open(딥링크 타깃) → ok");
  const og = await m("get", { id: s2.messageId, scope: SCOPE });
  ok(og.message.read === true, "open 이 그 메시지를 읽음 처리");

  // ── R7: 크로스윈도우 단일진실(Rust DB 공유) ──
  section("R7 cross-window");
  const win = await rpc("window.new", {});
  const label = win.label;
  ok(win.ok && typeof label === "string", `window.new → ${label}`);
  const ready = await waitWindowReady(label);
  ok(ready, "새 창 프론트 준비 완료(state.context ok)");
  // 기본 창에서 송신, 새 창 컨텍스트에서 코어 data.query 로 조회 → 동일 데이터(공유 Rust DB).
  const xs = await m("send", { title: "크로스윈도우 E2E", type: "info", to: SCOPE });
  await sleep(150);
  const fromWinB = await rpc(
    "data.query",
    { ns: PLUGIN, coll: "messages", scope: SCOPE, where: { read: false } },
    { window: label },
  );
  ok(fromWinB.ok && (fromWinB.rows || []).some((r) => r.id === xs.messageId),
    "새 창에서 data.query 가 방금 보낸 메시지를 봄(단일진실)");
  await rpc("window.close", { label }).catch(() => {});

  // ── R8: 백업 ──
  section("R8 backup");
  const bk = await rpc("data.backup", {});
  ok(bk.ok && typeof bk.path === "string" && fs.existsSync(bk.path), `data.backup → 파일 생성(${bk.path})`);

  // ── R9: export/import ──
  section("R9 export/import");
  const exp = await m("export", {});
  ok(exp.ok && exp.jsonl.includes("크로스윈도우 E2E"), "export → 이 메일함 JSONL");

  // ── teardown ──
  section("teardown");
  const cleared = await m("clear", { scope: SCOPE });
  ok(cleared.ok, `clear(scope) → ${cleared.deleted}건 삭제`);
  ok((await m("list", { scope: SCOPE })).messages.length === 0, "비움 확인");
  // 누수 창 정리(main 외 전부 닫기 — 멱등).
  const wl = await rpc("window.list", {});
  for (const lbl of (wl.labels || []).filter((x) => x !== "main")) {
    await rpc("window.close", { label: lbl }).catch(() => {});
  }

  // ── 결과 ──
  console.log(`\n${"=".repeat(40)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed}개 단언 전부 통과`);
    process.exit(0);
  } else {
    console.log(`FAIL — ${failures.length}개 실패:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("E2E 오류:", e);
  process.exit(1);
});
