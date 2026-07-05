#!/usr/bin/env node
// 리사이즈 E2E 드라이버 — soksak 소켓(JSON-RPC)에 직접 붙어 결정적 레이아웃을
// 구성하고, panel.resize "스톰"으로 리사이즈를 구동한다. 실제 마우스 드래그와
// 동일 경로(resizeSplit → 렌더 → 슬롯 크기 변경 → 터미널 ResizeObserver → fit +
// PTY IPC)를 타지만, 합성 마우스 없이 멱등·결정적이며 사용자 입력과 충돌하지 않는다.
//
// 사용:
//   node e2e-driver.mjs setup <repoRoot>          — resize-e2e(좌|우 터미널) 멱등 생성+활성, ids JSON
//   node e2e-driver.mjs prep <pane> <marker>      — 결정적 프롬프트(marker)+내용 채움
//   node e2e-driver.mjs prep-tui <pane>           — 결정적 TUI 프로브 실행(alt screen, WINCH 재그리기)
//   node e2e-driver.mjs cols <pane>               — 패널 셸의 현재 $COLUMNS 출력(자기검증용)
//   node e2e-driver.mjs read <pane> [lines]       — term.read 텍스트(끝에서 N줄) 출력
//   node e2e-driver.mjs storm <lo> <hi> <sec> <hz>— 루트 분할 비율을 lo~hi 로 진동(빠른 리사이즈)
//   node e2e-driver.mjs resize <fracLeft>         — 루트 분할 비율 설정 후 정착 대기
//   node e2e-driver.mjs teardown                  — resize-e2e 제거
//
// 환경: SOKSAK_SOCKET(필수).

import net from "node:net";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET = process.env.SOKSAK_SOCKET;
if (!SOCKET) {
  console.error("SOKSAK_SOCKET 이 필요합니다");
  process.exit(2);
}
const ALIAS = "resize-e2e";
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 소켓 RPC(perf/driver.mjs 와 동형) ────────────────────────────────────────
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
function rpc(sock, method, params = {}) {
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
    sock.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
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
  if (!r || r.ok !== true) throw new Error(`${what} 실패: ${JSON.stringify(r)}`);
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTree(sock) {
  return must(await rpc(sock, "state.tree"), "state.tree");
}
function findProj(tree) {
  return (tree.projects ?? []).find((p) => p.alias === ALIAS || p.title === ALIAS);
}
function activeProj(tree) {
  return (tree.projects ?? []).find((p) => p.active) ?? null;
}
function collectSplits(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.split) {
    out.push(node);
    for (const c of node.children ?? []) collectSplits(c, out);
  }
  return out;
}
function panesOf(proj) {
  const content = proj.contents.find((c) => c.active) ?? proj.contents[0];
  return (content.panels ?? []).map((g) => {
    const v = (g.views ?? []).find((x) => x.kind === "terminal") ?? g.views?.[0];
    return { group: g.id, view: v?.id, pane: v?.focusedPaneId ?? v?.id };
  });
}
function splitId(proj) {
  const content = proj.contents.find((c) => c.active) ?? proj.contents[0];
  const s = collectSplits(content.layout);
  if (!s.length) throw new Error("분할 노드 없음");
  return s[0].split.id;
}

// ── setup: 좌|우 터미널 2개. 생성 즉시 활성(렌더 대상)이어야 측정이 유효하다. ──
async function setup(sock, repoRoot) {
  const tree0 = await getTree(sock);
  const prev = findProj(tree0);
  if (prev) must(await rpc(sock, "project.close", { project: prev.id }), "이전 제거");

  const created = must(
    await rpc(sock, "project.create", {
      root: `${repoRoot}/scripts`,
      alias: ALIAS,
      program: "terminal",
    }),
    "project.create",
  );
  const project = created.projectId;
  must(
    await rpc(sock, "panel.split", {
      project,
      group: created.groupId,
      side: "right",
      program: "terminal",
    }),
    "panel.split right",
  );

  const tree1 = await getTree(sock);
  const proj = findProj(tree1);
  if (!proj) throw new Error("setup 후 프로젝트 없음");
  // 활성(렌더 대상) 확인 — 숨겨진 터미널은 fit 이 스킵되어 측정이 무효(거짓 GREEN).
  const act = activeProj(tree1);
  if (!act || act.id !== proj.id) {
    throw new Error(`resize-e2e 가 활성이 아님(active=${act?.id}) — 측정 무효`);
  }
  const content = proj.contents.find((c) => c.active) ?? proj.contents[0];
  const panes = panesOf(proj);
  console.log(
    JSON.stringify({
      project,
      contentId: content.id,
      rootSplitId: splitId(proj),
      paneLeft: panes[0]?.pane,
      paneRight: panes[1]?.pane,
    }),
  );
}

async function prep(sock, pane, marker) {
  const cmd =
    `precmd_functions=() 2>/dev/null; precmd(){ : ;} 2>/dev/null; ` +
    `PROMPT_COMMAND=''; PS1='${marker}'; PROMPT='${marker}'; ` +
    `clear; for i in $(seq 1 80); do echo "E2E row $i ABCDEFGH IJKLMNOP QRSTUVWX 0123456789 pad"; done`;
  must(await rpc(sock, "term.exec", { pane, cmd }), "prep term.exec");
}

async function prepTui(sock, pane) {
  const script = path.join(HERE, "tui-probe.sh");
  must(await rpc(sock, "term.exec", { pane, cmd: `clear; bash ${script}` }), "prep-tui");
}

async function read(sock, pane, lines) {
  const r = must(await rpc(sock, "term.read", { pane, lines }), "term.read");
  process.stdout.write(r.text ?? "");
}

// 현재 $COLUMNS — 자기검증(리사이즈가 실제로 fit/PTY 를 구동했는가)용. 마커는
// 호출별 고유(pid)여야 한다 — 버퍼에 남은 옛 마커를 잘못 잡는 것을 막는다.
async function cols(sock, pane) {
  const marker = `COLS_${process.pid}_`;
  must(await rpc(sock, "term.exec", { pane, cmd: `echo ${marker}$COLUMNS` }), "cols exec");
  await sleep(350);
  const r = must(await rpc(sock, "term.read", { pane, lines: 4 }), "cols read");
  const m = (r.text ?? "").match(new RegExp(`${marker}(\\d+)`));
  console.log(m ? m[1] : "-1");
}

// panel.resize 스톰: lo~hi 사이를 삼각파로 진동(실제 빠른 드래그와 동일 경로).
// 응답을 기다리지 않고 정확한 주기로 발사 — mousemove 폭주와 동형.
async function storm(sock, lo, hi, seconds, hz) {
  const tree = await getTree(sock);
  const proj = findProj(tree);
  if (!proj) throw new Error("프로젝트 없음");
  const sid = splitId(proj);
  const t0 = Date.now();
  let sent = 0,
    inFlight = 0,
    firstErr = null;
  const period = 1000 / hz;
  const span = hi - lo;
  while (Date.now() - t0 < seconds * 1000) {
    if (inFlight < 64) {
      const t = (Date.now() - t0) / 1000;
      // 삼각파(0~1~0) — 빠른 왕복으로 cols 가 프레임당 크게 점프.
      const ph = (t * 4) % 2; // 0.5Hz 왕복
      const a = lo + span * (ph < 1 ? ph : 2 - ph);
      inFlight++;
      rpc(sock, "panel.resize", { project: proj.id, split: sid, sizes: [a, 1 - a] })
        .then((r) => {
          if (r.ok !== true && !firstErr) firstErr = r;
        })
        .catch((e) => {
          if (!firstErr) firstErr = { message: String(e) };
        })
        .finally(() => inFlight--);
      sent++;
    }
    const next = t0 + sent * period - Date.now();
    if (next > 0) await sleep(next);
  }
  while (inFlight > 0) await sleep(20);
  // 시작=끝(net-zero): 0.5 로 복귀.
  await rpc(sock, "panel.resize", { project: proj.id, split: sid, sizes: [0.5, 0.5] });
  if (firstErr) throw new Error(`storm 실패: ${JSON.stringify(firstErr)}`);
  console.error(`storm: ${sent} calls, ${(sent / seconds).toFixed(0)}Hz`);
}

async function resize(sock, fracLeft) {
  const tree = await getTree(sock);
  const proj = findProj(tree);
  if (!proj) throw new Error("프로젝트 없음");
  must(
    await rpc(sock, "panel.resize", {
      project: proj.id,
      split: splitId(proj),
      sizes: [fracLeft, 1 - fracLeft],
    }),
    "panel.resize",
  );
  await sleep(450);
}

async function teardown(sock) {
  const tree = await getTree(sock);
  const prev = findProj(tree);
  if (prev) {
    must(await rpc(sock, "project.close", { project: prev.id }), "project.close");
    console.log(JSON.stringify({ removed: prev.id }));
  } else {
    console.log(JSON.stringify({ removed: null }));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const sock = await connect();
attach(sock);
try {
  if (cmd === "setup") await setup(sock, rest[0] ?? process.cwd());
  else if (cmd === "prep") await prep(sock, rest[0], rest[1]);
  else if (cmd === "prep-tui") await prepTui(sock, rest[0]);
  else if (cmd === "read") await read(sock, rest[0], rest[1] ? Number(rest[1]) : 1);
  else if (cmd === "cols") await cols(sock, rest[0]);
  else if (cmd === "storm")
    await storm(sock, Number(rest[0]), Number(rest[1]), Number(rest[2]), Number(rest[3] ?? 90));
  else if (cmd === "resize") await resize(sock, Number(rest[0]));
  else if (cmd === "teardown") await teardown(sock);
  else {
    console.error("사용법: setup|prep|prep-tui|cols|read|storm|resize|teardown");
    process.exit(2);
  }
} finally {
  sock.end();
}
