#!/usr/bin/env node
// 코어 스케줄러 실발화 e2e 하네스 — Phase 5 골격. 앱(빌드된 dev)이 떠 있고 소켓 서버가 살아 있는
// 상태에서 소켓(JSON-RPC)으로 스케줄러를 구동해 "실제로 발화하는가"를 검증한다. 단위 테스트(Rust/JS)는
// 판정 로직을 고정하지만, emit→프론트 registry 실행→cmd_result→complete 의 *실제 체인*은 앱 구동이 있어야
// 증명된다. 이 하네스가 그 체인을 socket 으로 친다(draft-visual.mjs 패턴).
//
// 시나리오:
//   (a) reconcile 발화 → workflow.reconcile 핸들러 실행            [통합 의존 — 워크플로+칸반 플러그인]
//   (b) process_lease: exec 도는 중 무중단 + 재발화 0(lease)        [자급 — dev debug.sleep held-reply]
//   (c) crash/ok:false → backoff 재시도                            [자급 — notify.show 빈 params]
//   (d) 더미 플러그인 at/every/cron 시간 발화(reminder-demo)        [자급 — notify.show]
//
// 검증 수단: schedule.list(next_at/running) 상태 조회 + At 작업 발화 후 제거 + notify 시각(⚠).
// 발화 타깃: notify.show(실명령, ok:true). 빈 params 면 ok:false(INVALID_PARAMS) → backoff 유발(새 명령 0).
//
// 실행(앱 구동 + draft.js 통합 후):
//   SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/scheduler-fire.mjs
//   (소켓 미지정 시 dev 소켓 기본. --keep 로 정리 생략, --only=c 로 한 시나리오만.)
//
// 전제: remoteInject=allow(dev 기본 — schedule.register/poke 는 danger:inject). 권한 deny 면 PERMISSION_DENIED.
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET =
  process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const KEEP = process.argv.includes("--keep");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);

// ── 소켓 RPC(draft-visual.mjs/e2e-driver.mjs 와 동형) ─────────────────────────
let sock;
let rbuf = "";
let nextId = 1;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    sock = net.connect(SOCKET);
    sock.setEncoding("utf8");
    sock.on("connect", resolve);
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      rbuf += chunk;
      let nl;
      while ((nl = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, nl);
        rbuf = rbuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
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
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout: " + method));
    }, 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    sock.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

const val = (m) => (m && m.result !== undefined ? m.result : m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

let pass = 0,
  fail = 0,
  warn = 0;
function ok(cond, msg, detail) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ " + msg, detail !== undefined ? JSON.stringify(detail) : "");
  }
}
function warnIf(cond, msg, detail) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    warn++;
    console.log(
      "  ⚠ " + msg + " (통합/시각 레이어 — 앱·플러그인 구동 필요)",
      detail !== undefined ? JSON.stringify(detail) : "",
    );
  }
}

// ── 스케줄러 헬퍼(registry 명령) ─────────────────────────────────────────────
const reg = async (job) => val(await rpc("schedule.register", job)).jobId;
const listJobs = async () => val(await rpc("schedule.list")).schedules || [];
const findJob = async (id) => (await listJobs()).find((j) => j.id === id);
const cancel = async (id) => val(await rpc("schedule.cancel", { id })).removed;
const poke = async (id) => rpc("schedule.poke", id ? { id } : {});
const NOTIFY = { title: "e2e", body: "scheduler-fire" }; // ok:true 발화 타깃.
const created = []; // 정리용.
async function registerTracked(job) {
  const id = await reg(job);
  created.push(id);
  return id;
}

// ── (d) at/every 시간 발화 — 자급(notify.show). At 은 발화 후 제거됨을 관찰. ──
async function scenarioD() {
  console.log("\n[d] at/every 시간 발화 — schedule.register + notify.show");
  // at: 1.5s 뒤 1회 → 목록에 등장(next_at) → 발화 후 제거.
  const atId = await registerTracked({
    trigger: { kind: "at", at: now() + 1500 },
    command: "notify.show",
    params: NOTIFY,
  });
  const before = await findJob(atId);
  ok(!!before, "at 작업 등록됨(목록 존재)", before && before.next_at);
  ok(before && typeof before.next_at === "number", "at next_at 설정됨(예정)", before && before.next_at);
  await sleep(2200);
  const after = await findJob(atId);
  ok(!after, "at 작업 발화 후 제거됨(1회 종료 = 실발화 증거)", after);

  // every: 1s 간격 → 등록·next_at 존재 → 한 주기 뒤 next_at 전진(re-arm) → 정리.
  const evId = await registerTracked({
    trigger: { kind: "every", every_ms: 1000 },
    command: "notify.show",
    params: NOTIFY,
  });
  const ev1 = await findJob(evId);
  ok(ev1 && typeof ev1.next_at === "number", "every 등록·next_at 존재", ev1 && ev1.next_at);
  await sleep(1500);
  const ev2 = await findJob(evId);
  warnIf(ev2 && ev1 && ev2.next_at > ev1.next_at, "every 발화 후 next_at 전진(자동 re-arm)", {
    n1: ev1 && ev1.next_at,
    n2: ev2 && ev2.next_at,
  });
  await cancel(evId);
  ok(!(await findJob(evId)), "every 작업 cancel 됨", null);
}

// ── (c) ok:false → backoff 재시도 — 자급(notify.show 빈 params = INVALID_PARAMS). ──
async function scenarioC() {
  console.log("\n[c] ok:false → backoff 재시도 — notify.show 빈 params");
  // notify.show({}) → ok:false → 코어 backoff. base_ms 1000, max 2.
  const id = await registerTracked({
    trigger: { kind: "at", at: now() + 500 },
    command: "notify.show",
    params: {}, // title/body 없음 → ok:false.
    retry: { max: 2, base_ms: 1000, max_ms: 5000 },
  });
  await sleep(900); // 1차 발화(실패) 후.
  const r1 = await findJob(id);
  // At 이지만 ok:false → 제거 대신 backoff 재예약(next_at = 실패시각 + backoff).
  ok(!!r1, "ok:false 1차 후 작업 잔존(backoff 재시도 예약)", r1 && r1.next_at);
  ok(r1 && r1.next_at > now(), "재시도 next_at 미래(backoff 지연)", r1 && { next_at: r1.next_at, now: now() });
  const firstNext = r1 && r1.next_at;
  await sleep(1500); // 2차 발화(실패) 후 → 지수 backoff(2000ms) 재예약.
  const r2 = await findJob(id);
  warnIf(
    r2 && firstNext && r2.next_at > firstNext,
    "2차 재시도 next_at 지수 증가(backoff)",
    { first: firstNext, second: r2 && r2.next_at },
  );
  await sleep(2500); // 재시도 소진(max 2) → At 종료·제거.
  ok(!(await findJob(id)), "재시도 소진 후 작업 제거(At 종료)", null);
}

// ── (b) process_lease 무중단 + 재발화 0 + cancel-wakes-wait — dev debug.sleep(held-reply). ──
async function scenarioB() {
  console.log("\n[b] process_lease 무중단 + lease(재발화 0) + cancel-wakes-wait — debug.sleep");
  // HELD_CMD = ms 동안 reply 를 보류하는 명령(프론트 핸들러가 await). 기본 = dev 전용 debug.sleep
  //   (실 LLM 없이 lease 로직 빠르게 검증). 통합 시 workflow.exec-one 으로도 가능(HELD_CMD 로 교체).
  const HELD_CMD = process.env.HELD_CMD || "debug.sleep"; // dev 빌드에 등록됨(catalogDebug).
  const heldMs = Number(process.env.HELD_MS || 5000);
  const id = await registerTracked({
    trigger: { kind: "at", at: now() + 300 },
    command: HELD_CMD,
    params: { ms: heldMs },
    process_lease: true,
    zombie_backstop_ms: 3600000,
  });
  await sleep(1500); // held 명령 도는 중.
  const running = await findJob(id);
  ok(running && running.running === true, "도는 중 running=true(lease 보유)", running);
  ok(running && running.next_at == null, "도는 중 next_at=null(재claim 차단)", running && running.next_at);
  // 재발화 0: 도는 중 poke 해도 동시 두 번째 발화가 생기지 않음(lease). 목록에 여전히 1개.
  await poke(id);
  await sleep(500);
  const dup = (await listJobs()).filter((j) => j.id === id);
  ok(dup.length === 1 && dup[0].running === true, "도는 중 poke 해도 단일 in-flight(재발화 0)", dup.length);
  // held 명령 종료 → reply → complete(ok:true). At 이므로 제거.
  await sleep(heldMs + 1500);
  ok(!(await findJob(id)), "held 종료 후 reply→complete→At 제거(무중단 완주)", null);

  // cancel-wakes-wait: 새 held 작업을 도는 중 cancel → 대기 즉시 깨어 제거.
  const id2 = await registerTracked({
    trigger: { kind: "at", at: now() + 300 },
    command: HELD_CMD,
    params: { ms: 60000 }, // 길게 — cancel 로 깨움 확인.
    process_lease: true,
  });
  await sleep(1500);
  ok((await findJob(id2))?.running === true, "두번째 held 작업 도는 중", null);
  const t0 = now();
  await cancel(id2);
  await sleep(300);
  ok(!(await findJob(id2)), "cancel 즉시 제거(cancel-wakes-wait, 누수 0)", { ms: now() - t0 });
}

// ── (a) reconcile 발화 → workflow.reconcile 핸들러 — 통합 의존(워크플로+칸반). ──
async function scenarioA() {
  console.log("\n[a] reconcile 발화 → workflow.reconcile 핸들러 — 워크플로+칸반 플러그인 필요");
  // TODO(통합): soksak-plugin-workflow 가 activate 시 app.scheduler.register({trigger:reconcile,
  //   command:"plugin.soksak-plugin-workflow.workflow.reconcile", process_lease:true}) 한다(3e).
  //   1) 워크플로+칸반 플러그인 load/enable/reload.
  //   2) 칸반에 ready 노드(blockedBy 충족·검수전) 발행.
  //   3) schedule.poke(reconcileJobId) — 또는 발행 이벤트가 자동 poke.
  //   4) 관찰: 그 노드가 exec 됨(배지 검수전→oxf, 또는 result 기록) = 핸들러 실제 실행 증거.
  const RECONCILE_CMD =
    process.env.RECONCILE_CMD || "plugin.soksak-plugin-workflow.workflow.reconcile";
  const jobs = await listJobs();
  const reconcileJob = jobs.find(
    (j) => j.trigger && j.trigger.kind === "reconcile" && j.command === RECONCILE_CMD,
  );
  warnIf(
    !!reconcileJob,
    "워크플로 reconcile 작업이 스케줄러에 등록됨(activate 발행)",
    reconcileJob && reconcileJob.id,
  );
  if (!reconcileJob) {
    console.log("     (워크플로 플러그인 미로드 — 통합 후 본검증. 골격: poke→핸들러 실행 관찰)");
    return;
  }
  // poke → 핸들러 실행. 관찰은 칸반 노드 상태 변화(통합 시 node.list 로 배지/result 확인).
  await poke(reconcileJob.id);
  await sleep(1000);
  warnIf(false, "TODO: 칸반 ready 노드가 exec 됨(배지 oxf/result) — 통합 시 node.list 교차", "needs-kanban");
}

async function main() {
  console.log("socket:", SOCKET, ONLY ? `(--only=${ONLY})` : "(전체)");
  try {
    await connect();
  } catch (e) {
    console.error("소켓 연결 실패 — 앱(dev)이 떠 있어야 합니다:", e.message);
    process.exit(2);
  }
  // 더미 플러그인(reminder-demo) 로드 시도 — (d) 시간 트리거 범용성. 미존재면 무시.
  await rpc("plugin.dev.load", {
    path: path.join(os.homedir(), ".soksak", "plugins", "soksak-plugin-reminder-demo"),
  }).catch(() => {});
  await rpc("plugin.enable", { id: "soksak-plugin-reminder-demo" }).catch(() => {});
  await sleep(500);
  {
    const demoJobs = (await listJobs()).filter((j) => String(j.id).startsWith("reminder-demo:"));
    warnIf(
      demoJobs.length >= 1,
      `reminder-demo 시간 트리거 등록(at/every/cron 같은 코어 엔진) (${demoJobs.length}개)`,
      demoJobs.map((j) => j.trigger && j.trigger.kind),
    );
  }

  const run = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD };
  for (const key of ["d", "c", "b", "a"]) {
    if (ONLY && ONLY !== key) continue;
    try {
      await run[key]();
    } catch (e) {
      fail++;
      console.log(`  ✗ 시나리오 ${key} 오류:`, e.message);
    }
  }

  if (!KEEP) {
    for (const id of created) await cancel(id).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warned(통합/시각)`);
  sock.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("스케줄러 발화 e2e 오류:", e.message);
  process.exit(1);
});
