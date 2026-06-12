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
// 환경: SOKSAK_SOCKET(필수) — 대상 인스턴스 소켓 경로.

import net from "node:net";
import process from "node:process";

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

function rpc(sock, method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
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
  if (!r || r.ok !== true) {
    throw new Error(`${what} 실패: ${JSON.stringify(r)}`);
  }
  return r;
}

// ── 트리 헬퍼 ───────────────────────────────────────────────────────────────
async function getTree(sock) {
  return must(await rpc(sock, "state.tree"), "state.tree");
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
    await rpc(sock, "project.create", {
      root: `${repoRoot}/node_modules`,
      alias: ALIAS,
      program: "terminal",
    }),
    "project.create",
  );
  const project = created.projectId;
  const gLeft = created.groupId;

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
  const gRight = right.groupId;

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
  const gBrowser = bottom.groupId;
  must(
    await rpc(sock, "view.open", {
      group: gBrowser,
      program: "browser",
      url: "about:blank",
    }),
    "view.open browser",
  );

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
  const content = proj.contents.find((c) => c.active) ?? proj.contents[0];
  const splits = collectSplits(content.layout);
  if (splits.length === 0) throw new Error("분할 노드 없음");
  // 루트 분할(트리 최상단) = 좌|우 경계.
  const rootSplit = splits[0];

  const ids = {
    project,
    contentId: content.id,
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
    console.error("사용법: driver.mjs setup|s1|s2|teardown|tree");
    process.exit(2);
  }
} finally {
  sock.end();
}
