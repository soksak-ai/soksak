#!/usr/bin/env node
// 퍼포먼스 하니스 드라이버 — soksak 소켓(JSON-RPC, 한 줄 요청/응답)에 직접 붙어
// 시나리오를 정밀한 빈도로 구동한다. sok CLI 프로세스 스폰 오버헤드 없이
// 단일 연결로 60~120Hz 수준의 명령 스트림을 만들 수 있다.
//
// 사용:
//   node driver.mjs setup            — perf-harness 프로젝트를 멱등 생성, ids JSON 출력
//   node driver.mjs s1 <sec> [hz]    — 디바이더 리사이즈 스톰(루트 분할 비율 진동)
//   node driver.mjs s2 <sec> [hz]    — 뷰 이동(드롭) 왕복
//   node driver.mjs teardown         — perf-harness 프로젝트 제거
//   node driver.mjs tree             — state.tree 원본 출력(디버그용)
//
// 터미널 성능(t 시나리오 — W4, budgets 게이트 입력):
//   node driver.mjs setup-t          — 터미널 1개짜리 perf-harness-t 프로젝트 멱등 생성, ids JSON
//   node driver.mjs t1 <plain|ansi> [MB]  — 처리량: 고정 픽스처 cat, 완료는 terminal.command.finished
//                                            이벤트(events.subscribe push — 폴링 0)로 잰다
//   node driver.mjs t2 [n]           — 입력 레이턴시(L1): plugin perf.echo 왕복 n회 통계
//   node driver.mjs teardown-t       — perf-harness-t 프로젝트 제거
//
// 환경: SOKSAK_SOCKET(필수) — 대상 인스턴스 소켓 경로. PERF_IDS — setup-t 출력(t1/t2 대상).

import net from "node:net";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SOCKET = process.env.SOKSAK_SOCKET;
if (!SOCKET) {
  console.error("SOKSAK_SOCKET 이 필요합니다 (예: ~/.soksak/com.soksak.debug.sock)");
  process.exit(2);
}

const ALIAS = "perf-harness";

// ── 소켓 RPC ────────────────────────────────────────────────────────────────
function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

let seq = 0;
const pending = new Map();
let buf = "";

function attach(sock) {
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
}

function rpc(sock, method, params = {}, window = undefined) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify(window ? { id, method, params, window } : { id, method, params }) + "\n", (err) => {
      if (err) {
        pending.delete(id);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT: ${method}`));
      }
    }, 15000);
  });
}

function must(r, what) {
  if (!r || r.ok !== true) {
    throw new Error(`${what} 실패: ${JSON.stringify(r)}`);
  }
  return r;
}

// ── 트리 헬퍼 ───────────────────────────────────────────────────────────────
// 메시지 프로토콜 v1 봉투 {ok,code,message,data} — 트리 본문은 data 아래(구 평면 응답도 수용).
async function getTree(sock, window = undefined) {
  const r = must(await rpc(sock, "state.tree", {}, window), "state.tree");
  return r.data ?? r;
}

function findPerfProject(tree) {
  return (tree.projects ?? []).find((p) => p.alias === ALIAS || p.title === ALIAS);
}

// content.layout 트리에서 split 노드들을 수집한다.
// 노드 형식: { split: { id, dir, sizes }, children: [...] } | { panel: "gN" }
function collectSplits(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.split) {
    out.push(node);
    for (const c of node.children ?? []) collectSplits(c, out);
  }
  return out;
}

// ── setup: 멱등 레이아웃 ────────────────────────────────────────────────────
// 좌(터미널) | 우상(파일 에디터) / 우하(브라우저 about:blank) + 보조 터미널 뷰.
async function setup(sock, repoRoot) {
  // 기존 perf 프로젝트 제거(멱등).
  const tree0 = await getTree(sock);
  const prev = findPerfProject(tree0);
  if (prev) {
    must(
      await rpc(sock, "project.close", { project: prev.id }),
      "이전 perf-harness 제거",
    );
  }

  // 프로젝트 루트 = node_modules: 파일트리가 수백 항목으로 오버플로해야
  // s6(트리 스크롤)이 유효한 시나리오가 된다(루트 ~20개면 스크롤 자체가 무효).
  const created = must(
    await rpc(sock, "project.open", {
      root: `${repoRoot}/node_modules`,
      alias: ALIAS,
      program: "terminal",
    }),
    "project.open",
  );
  const project = created.projectId;
  const gLeft = created.panelId;

  // 우측 컬럼: 파일 에디터.
  const right = must(
    await rpc(sock, "panel.split", {
      project,
      group: gLeft,
      side: "right",
      program: "terminal",
    }),
    "panel.split right",
  );
  const gRight = right.panelId;

  // 우상단 패널에 파일 에디터 열기(스크롤 시나리오 대상 — 충분히 긴 파일).
  // editor.open 은 활성 그룹에 열리므로 먼저 gRight 를 활성화한다.
  must(await rpc(sock, "panel.focus", { group: gRight }), "panel.focus gRight");
  must(
    await rpc(sock, "editor.open", {
      project,
      path: `${repoRoot}/src/App.css`,
    }),
    "editor.open",
  );

  // 우하단: 브라우저(about:blank — 네트워크 노이즈 제거).
  const bottom = must(
    await rpc(sock, "panel.split", {
      project,
      group: gRight,
      side: "bottom",
      program: "terminal",
    }),
    "panel.split bottom",
  );
  const gBrowser = bottom.panelId;
  const browserView = must(
    await rpc(sock, "view.open", {
      group: gBrowser,
      program: "browser",
    }),
    "view.open browser",
  );
  // 네비게이션은 브라우저 플러그인 커맨드로 분리되어 있다(view.open 은 program 만 받음).
  // view.open 반환 시점에 브라우저 뷰 마운트·등록이 끝나지 않을 수 있어 유한 재시도.
  {
    let nav;
    for (let i = 0; i < 20; i++) {
      nav = await rpc(sock, "plugin.soksak-plugin-browser-native.navigate", {
        url: "about:blank",
        viewId: browserView.viewId,
      });
      if (nav?.ok === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    must(nav, "browser navigate");
  }

  // s2 용: 이동해도 그룹이 해체되지 않도록 우상단에 보조 터미널 뷰 1개 추가,
  // 그 뷰를 왕복 이동 대상으로 쓴다.
  const mover = must(
    await rpc(sock, "view.open", { group: gRight, program: "terminal" }),
    "view.open mover",
  );

  // 분할 id 수집(루트 row 분할 = s1 대상).
  const tree1 = await getTree(sock);
  const proj = findPerfProject(tree1);
  if (!proj) throw new Error("setup 후 perf-harness 프로젝트를 찾지 못함");
  const space = proj.spaces.find((c) => c.active) ?? proj.spaces[0];
  const splits = collectSplits(space.layout);
  if (splits.length === 0) throw new Error("분할 노드 없음");
  // 루트 분할(트리 최상단) = 좌|우 경계.
  const rootSplit = splits[0];

  const ids = {
    project,
    spaceId: space.id,
    rootSplitId: rootSplit.split.id,
    rootSizes: rootSplit.split.sizes ?? [0.5, 0.5],
    gLeft,
    gRight,
    gBrowser,
    moverViewId: mover.viewId,
  };
  console.log(JSON.stringify(ids));
}

// ── 파이프라인 스톰 공용부 ──────────────────────────────────────────────────
// 응답을 기다리지 않고 정확한 주기로 요청을 발사(실제 mousemove 폭주와 동일).
// 응답은 비동기로 수거해 오류만 검사. in-flight 상한으로 무한 적체 방지.
async function storm(sock, seconds, hz, makeCall, label) {
  const t0 = Date.now();
  let sent = 0;
  let skipped = 0;
  let inFlight = 0;
  let firstErr = null;
  const period = 1000 / hz;
  while (Date.now() - t0 < seconds * 1000) {
    if (inFlight < 64) {
      inFlight++;
      makeCall((Date.now() - t0) / 1000)
        .then((r) => {
          if (r.ok !== true && !firstErr) firstErr = r;
        })
        .catch((e) => {
          if (!firstErr) firstErr = { message: String(e) };
        })
        .finally(() => {
          inFlight--;
        });
      sent++;
    } else {
      skipped++;
    }
    const next = t0 + (sent + skipped) * period - Date.now();
    if (next > 0) await new Promise((res) => setTimeout(res, next));
  }
  // 잔여 응답 수거.
  while (inFlight > 0) await new Promise((res) => setTimeout(res, 20));
  if (firstErr) throw new Error(`${label} 실패: ${JSON.stringify(firstErr)}`);
  console.log(
    JSON.stringify({ scenario: label, calls: sent, skipped, achievedHz: sent / seconds }),
  );
}

// ── s1: 디바이더 리사이즈 스톰 ──────────────────────────────────────────────
// 실제 드래그와 동일 경로: resizeSplit 스토어 쓰기 → 렌더 → 슬롯 크기 변경 →
// 터미널 ResizeObserver → fit + PTY IPC. sizes 를 사인파로 진동.
async function s1(sock, ids, seconds, hz) {
  await storm(
    sock,
    seconds,
    hz,
    (t) => {
      const a = 0.5 + 0.2 * Math.sin(t * Math.PI * 2 * 0.5); // 0.3~0.7, 0.5Hz 왕복
      return rpc(sock, "panel.resize", {
        project: ids.project,
        split: ids.rootSplitId,
        sizes: [a, 1 - a],
      });
    },
    "s1",
  );
  // 원위치.
  await rpc(sock, "panel.resize", {
    project: ids.project,
    split: ids.rootSplitId,
    sizes: [0.5, 0.5],
  });
}

// ── s2: 뷰 이동(드롭) 왕복 ──────────────────────────────────────────────────
// 구조 변경 명령이라 순서 보존이 필요 → 직렬이되 주기 목표만 유지.
async function s2(sock, ids, seconds, hz) {
  const t0 = Date.now();
  let n = 0;
  const period = 1000 / hz;
  let at = ids.gRight;
  while (Date.now() - t0 < seconds * 1000) {
    const dst = at === ids.gRight ? ids.gBrowser : ids.gRight;
    const r = await rpc(sock, "view.move", {
      view: ids.moverViewId,
      dst,
      zone: "center",
    });
    if (r.ok !== true) throw new Error(`view.move 실패: ${JSON.stringify(r)}`);
    at = dst;
    n++;
    const next = t0 + n * period - Date.now();
    if (next > 0) await new Promise((res) => setTimeout(res, next));
  }
  console.log(JSON.stringify({ scenario: "s2", calls: n, achievedHz: n / seconds }));
}

// ── teardown ────────────────────────────────────────────────────────────────
async function teardown(sock) {
  const tree = await getTree(sock);
  const prev = findPerfProject(tree);
  if (prev) {
    must(await rpc(sock, "project.close", { project: prev.id }), "project.close");
    console.log(JSON.stringify({ removed: prev.id }));
  } else {
    console.log(JSON.stringify({ removed: null }));
  }
}

// ═══ t 시나리오 — 터미널 성능(W4) ══════════════════════════════════════════
// 측정 채널: ① 완료 = terminal.command.finished 활동 이벤트(events.subscribe push — 폴링 0)
//           ② 카운터 = plugin.soksak-plugin-terminal-xterm.perf.stats 두 스냅샷의 차분(pull)
//           ③ 입력 레이턴시 = plugin.soksak-plugin-terminal-xterm.perf.echo(onData 도착이 해소)

const ALIAS_T = "perf-harness-t";
const E2E_ROOT = path.join(os.homedir(), ".soksak-e2e", "perf");
const FIXTURE_DIR = path.join(E2E_ROOT, "fixtures");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 고정 픽스처(멱등·결정적): plain=ASCII 줄, ansi=SGR(16/256색)+리셋 반복 줄.
// 커밋하지 않는다(수십 MB) — 내용이 결정적이라 어느 머신에서든 같은 바이트가 재생된다.
function ensureFixture(kind, mb) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${kind}-${mb}mb.txt`);
  const want = mb * 1024 * 1024;
  if (fs.existsSync(file) && fs.statSync(file).size === want) return file;
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  let written = 0;
  let i = 0;
  let chunk = "";
  while (written + chunk.length < want) {
    const line =
      kind === "ansi"
        ? `\x1b[1;${31 + (i % 7)}m${String(i).padStart(8, "0")}\x1b[0m \x1b[4${i % 8}m block \x1b[0m \x1b[38;5;${i % 256}mtruecolorish sample text\x1b[0m\n`
        : `${String(i).padStart(8, "0")} the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuvwxyz\n`;
    chunk += line;
    i++;
    if (chunk.length >= 1 << 16) {
      fs.writeSync(fd, chunk);
      written += chunk.length;
      chunk = "";
    }
  }
  // 잔여 + 정확한 크기 맞춤(마지막 바이트는 개행).
  const rest = want - written - chunk.length;
  chunk += rest > 0 ? "#".repeat(rest - 1) + "\n" : "";
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  fs.renameSync(tmp, file); // 원자 배치 — 부분 파일이 픽스처로 보이지 않게
  return file;
}

// 활동 이벤트 push 스트림(events.subscribe) — 요청-응답에서 이탈한 전용 연결.
// next(predicate)는 백로그를 먼저 훑고, 이후 도착분에서 해소된다(폴링 0).
async function subscribeEvents(kinds) {
  const s = await connect();
  let buf = "";
  const backlog = [];
  const waiters = []; // {pred, resolve, reject, timer}
  s.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.subscribed === true) continue; // 구독 확인 응답
      backlog.push(msg);
      for (let w = 0; w < waiters.length; w++) {
        if (waiters[w].pred(msg)) {
          const { resolve, timer } = waiters.splice(w, 1)[0];
          clearTimeout(timer);
          resolve(msg);
          break;
        }
      }
    }
  });
  await new Promise((resolve, reject) => {
    s.write(
      JSON.stringify({ id: 1, method: "events.subscribe", params: { kinds } }) + "\n",
      (err) => (err ? reject(err) : resolve()),
    );
  });
  return {
    next(pred, timeoutMs, label) {
      const hit = backlog.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`이벤트 대기 타임아웃(${timeoutMs}ms): ${label}`));
        }, timeoutMs);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    close() {
      s.end();
      s.destroy();
    },
  };
}

const PERF_STATS_CMD = "plugin.soksak-plugin-terminal-xterm.perf.stats";
const PERF_ECHO_CMD = "plugin.soksak-plugin-terminal-xterm.perf.echo";

async function perfStats(sock, ids) {
  const r = must(
    await rpc(sock, PERF_STATS_CMD, { view: ids.termViewId }, ids.window),
    "perf.stats",
  );
  return (r.data ?? r).views[ids.termViewId];
}

const T_ROOT = path.join(E2E_ROOT, ALIAS_T); // 프로젝트 루트 = 고정 경로(멱등 재사용)

// 컨트롤 플레인 모델: 프로젝트는 워크스페이스 창(w-*) 소유 — window.projects 로 찾는다.
async function findTWindow(sock) {
  const r = must(await rpc(sock, "window.projects"), "window.projects");
  const hit = (r.data?.projects ?? r.projects ?? []).find(
    (p) => p.name === ALIAS_T || p.root === T_ROOT || String(p.root ?? "").endsWith(`/${ALIAS_T}`),
  );
  return hit?.window ?? null;
}

// 창 닫기(베스트에포트) — 닫히는 창은 응답 전에 소멸할 수 있어 TIMEOUT 응답이 정상 경로다.
// 성공 판정은 응답이 아니라 window.projects 에서의 소멸로 한다.
async function closeWindowSettled(sock, label) {
  await rpc(sock, "window.close", { label }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if ((await findTWindow(sock)) === null) return;
    await sleep(250);
  }
  throw new Error(`창이 닫히지 않음: ${label}`);
}

// ── setup-t: 터미널 1개짜리 측정 워크스페이스(멱등 — 잔존 창은 닫고 신선 생성) ──
async function setupT(sock) {
  const prevWin = await findTWindow(sock);
  if (prevWin) {
    await closeWindowSettled(sock, prevWin);
    await sleep(500);
  }
  fs.mkdirSync(T_ROOT, { recursive: true });
  // 명시적으로 제어판(main)에 열기를 요청한다 — 제어판은 전용 워크스페이스 창으로 라우팅하므로
  // ({routedWindow}) 측정 프로젝트가 항상 자기 창에 격리된다. window 미지정이면 "마지막 포커스
  // 창"에 탭으로 얹혀 기존 워크스페이스를 오염시킨다(실측).
  const openedRaw = must(
    await rpc(sock, "project.open", { root: T_ROOT, alias: ALIAS_T, program: "terminal" }, "main"),
    "project.open",
  );
  const created = openedRaw.data ?? openedRaw;
  // 라우팅은 root 만 넘기므로(빈 스페이스 부트) 터미널 뷰는 아래서 view.open 으로 연다.
  const window = created.routedWindow ?? created.existingWindow ?? null;
  if (!window) throw new Error(`제어판 라우팅 실패(routedWindow 없음): ${JSON.stringify(created)}`);

  // 새 창 부팅(웹뷰 로드+플러그인 활성화) 대기 — 부팅 준비 확인 한정 유한 재시도
  // (측정 경로 아님. 준비 신호가 하니스에 push 로 노출되면 대체한다).
  let termViewId = created.viewId ?? null;
  let project = created.projectId ?? null;
  let panelId = created.panelId ?? null;
  for (let i = 0; i < 120 && !termViewId; i++) {
    const tree = await getTree(sock, window ?? undefined).catch(() => null);
    if (tree) {
      for (const proj of tree.projects ?? []) {
        for (const space of proj.spaces ?? [])
          for (const p of space.panels ?? []) {
            project ??= proj.id;
            panelId ??= p.id;
            for (const v of p.views ?? [])
              if (v.plugin === "soksak-plugin-terminal-xterm" || v.kind === "terminal") {
                termViewId = v.id;
                project = proj.id;
              }
          }
      }
      if (!termViewId && panelId) {
        // 빈 스페이스 부트(라우팅 경로) — 터미널 뷰를 연다. 플러그인 활성화 전이면
        // 실패할 수 있어 부팅 재시도 루프 안에서 시도한다.
        const opened = await rpc(
          sock,
          "view.open",
          { panel: panelId, program: "terminal" },
          window ?? undefined,
        );
        const od = opened.data ?? opened;
        if (opened.ok === true && od.viewId) termViewId = od.viewId;
      }
    }
    if (!termViewId) await sleep(500);
  }
  if (!termViewId) throw new Error("터미널 뷰 준비 타임아웃(새 창 부팅 실패?)");

  // 셸 프롬프트 준비 대기(위와 같은 부팅 한정 재시도).
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await rpc(sock, "term.read", { pane: termViewId }, window ?? undefined);
    if (r.ok === true && /\S/.test((r.data ?? r).text ?? "")) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!ready) throw new Error("터미널 프롬프트 준비 타임아웃");
  // windowsOpen = 측정 조건 기록(t5/t6 은 앱 전체 측정 — 창 개수가 다르면 비교 무효).
  const wl = must(await rpc(sock, "window.list"), "window.list");
  const windowsOpen = ((wl.data ?? wl).labels ?? []).length;
  console.log(JSON.stringify({ window, project, termViewId, windowsOpen }));
}

// ── t1: 처리량 — 고정 픽스처 cat, 시작/완료는 활동 이벤트 ts(허브 부여)로 ──
async function t1(sock, ids, kind, mb) {
  const file = ensureFixture(kind, mb);
  const bytes = fs.statSync(file).size;
  const marker = path.basename(file);
  const ev = await subscribeEvents(["terminal.command"]);
  try {
    const before = await perfStats(sock, ids);
    must(
      await rpc(sock, "term.exec", { pane: ids.termViewId, cmd: `cat ${file}` }, ids.window),
      "term.exec",
    );
    const started = await ev.next(
      (e) =>
        e.kind === "terminal.command.started" &&
        String(e.payload?.commandLine ?? "").includes(marker),
      30_000,
      "terminal.command.started(cat)",
    );
    const finished = await ev.next(
      (e) =>
        e.kind === "terminal.command.finished" &&
        String(e.payload?.commandLine ?? "").includes(marker) &&
        e.seq > started.seq,
      600_000,
      "terminal.command.finished(cat)",
    );
    // 카운터 정착(마지막 write 콜백/ACK) 후 스냅샷.
    await sleep(300);
    const after = await perfStats(sock, ids);
    const durationMs = finished.ts - started.ts;
    console.log(
      JSON.stringify({
        scenario: `t1_${kind}`,
        fixture: marker,
        bytes,
        durationMs,
        mbps: +(bytes / 1048576 / (durationMs / 1000)).toFixed(2),
        exitCode: finished.payload?.exitCode ?? null,
        counters: {
          writtenBytesDelta: after.writtenBytes - before.writtenBytes,
          ackSentDelta: after.ackSent - before.ackSent,
          writeCbLagMsDelta: after.writeCbLagMs - before.writeCbLagMs,
          rafFramesDelta: after.rafFrameCount - before.rafFrameCount,
          webglActive: after.webglActive,
          scrollbackRows: after.scrollbackRows,
        },
      }),
    );
  } finally {
    ev.close();
  }
}

// ── t2: 입력 레이턴시 L1 — perf.echo 왕복 n회(직렬) ────────────────────────
// 측정점 = 플러그인 write→PTY 에코→onData 도착. 소켓 RPC·페인트는 포함하지 않는다
// (페인트 포함 축은 perf.stats 의 writeCbLagMs/rafFrameCount — 측정점 차이를 리포트에 명시).
async function t2(sock, ids, n) {
  // 워밍업 3회(첫 왕복은 콜드 경로 — 셸/xterm 웜업 편차 제거).
  for (let i = 0; i < 3; i++) {
    await rpc(sock, PERF_ECHO_CMD, { view: ids.termViewId }, ids.window);
    await sleep(50);
  }
  const samples = [];
  for (let i = 0; i < n; i++) {
    const r = must(
      await rpc(sock, PERF_ECHO_CMD, { view: ids.termViewId }, ids.window),
      "perf.echo",
    );
    samples.push((r.data ?? r).roundtripMs);
    await sleep(30); // 프로브 간 간격 — 에코 겹침(이전 출력 오귀속) 방지
  }
  samples.sort((a, b) => a - b);
  const q = (p) => +samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(2);
  console.log(
    JSON.stringify({
      scenario: "t2",
      samples: samples.length,
      minMs: +samples[0].toFixed(2),
      medianMs: q(0.5),
      p95Ms: q(0.95),
      maxMs: +samples[samples.length - 1].toFixed(2),
      measurementPoint: "plugin write -> PTY echo -> onData arrival (socket RPC/paint excluded)",
    }),
  );
}

// ── teardown-t ──────────────────────────────────────────────────────────────
async function teardownT(sock) {
  const win = await findTWindow(sock);
  if (win) {
    await closeWindowSettled(sock, win);
    console.log(JSON.stringify({ removed: win }));
  } else {
    console.log(JSON.stringify({ removed: null }));
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const sock = await connect();
attach(sock);

try {
  if (cmd === "setup") {
    const repoRoot = rest[0] ?? process.cwd();
    await setup(sock, repoRoot);
  } else if (cmd === "s1" || cmd === "s2") {
    const seconds = Number(rest[0] ?? 5);
    const hz = Number(rest[1] ?? 90);
    const ids = JSON.parse(
      process.env.PERF_IDS ?? rest[2] ?? "",
    );
    if (cmd === "s1") await s1(sock, ids, seconds, hz);
    else await s2(sock, ids, seconds, hz);
  } else if (cmd === "teardown") {
    await teardown(sock);
  } else if (cmd === "setup-t") {
    await setupT(sock);
  } else if (cmd === "t1") {
    const kind = rest[0] ?? "plain";
    if (kind !== "plain" && kind !== "ansi") throw new Error(`t1 kind: plain|ansi (받음: ${kind})`);
    const mb = Number(rest[1] ?? 100);
    const ids = JSON.parse(process.env.PERF_IDS ?? rest[2] ?? "");
    await t1(sock, ids, kind, mb);
  } else if (cmd === "t2") {
    const n = Number(rest[0] ?? 50);
    const ids = JSON.parse(process.env.PERF_IDS ?? rest[1] ?? "");
    await t2(sock, ids, n);
  } else if (cmd === "teardown-t") {
    await teardownT(sock);
  } else if (cmd === "ping") {
    // RTT 진단: state.tree(읽기) vs panel.resize(쓰기+렌더) 라운드트립 분리 측정.
    const n = Number(rest[0] ?? 10);
    const t = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      must(await rpc(sock, "state.tree"), "state.tree");
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    console.log(
      JSON.stringify({
        rpc: "state.tree",
        median: +t[Math.floor(n / 2)].toFixed(1),
        min: +t[0].toFixed(1),
        max: +t[n - 1].toFixed(1),
      }),
    );
  } else if (cmd === "tree") {
    console.log(JSON.stringify(await getTree(sock), null, 2));
  } else {
    console.error(
      "사용법: driver.mjs setup|s1|s2|teardown|setup-t|t1|t2|teardown-t|tree",
    );
    process.exit(2);
  }
} finally {
  sock.end();
}
