// [단계⑤] AI 세션 계보 추적 — claude 가 /clear·/resume 분기를 파일에 안 남기므로(실측), 터미널이
// claude 를 돌리는 동안 그 cwd 세션 디렉토리를 watch 해서 우리가 전이를 관찰한다. notify fs-change
// 이벤트가 구동한다 — OS 가 파일 변경 시에만 깨운다(주기 조회 0, 폴링 아님). 전이 판정(직전 스냅샷 대비
// 방금 쓰인 세션)은 코어 ai_session_active(SessionTracker)가 단일진실로 수행하고, 여기선 배선만 한다.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const LINEAGE_NS = "core";
const LINEAGE_COLL = "ai_session_lineage";

type Tracked = { viewIds: Set<string>; lastSession: string | null; cwd: string };
// 세션 디렉토리별 추적(같은 cwd 멀티 터미널은 dir 공유 — PID 가 없어 더 못 좁힌다). viewId→dir 역인덱스.
const byDir = new Map<string, Tracked>();
const viewToDir = new Map<string, string>();
let fsUnlisten: (() => void) | null = null;
let defined = false;

async function ensureDefined(): Promise<void> {
  if (defined) return;
  defined = true;
  await invoke("data_define", { ns: LINEAGE_NS, coll: LINEAGE_COLL, indexes: ["viewId"], fts: [] }).catch(() => {});
}

function ensureFsListener(): void {
  if (fsUnlisten) return;
  // notify fs-change(변경 항목의 부모 디렉토리) — 우리가 watch 중인 세션 디렉토리면 그때만 확정.
  void listen<string>("fs-change", (e) => {
    if (byDir.has(e.payload)) void refresh(e.payload);
  })
    .then((u) => {
      fsUnlisten = u;
    })
    .catch(() => {});
}

// fs-change 이벤트 시 — dir 의 활성 세션을 코어에 확정시키고(직전 스냅샷 비교), 직전과 다르면 전이로 기록.
async function refresh(dir: string): Promise<void> {
  const t = byDir.get(dir);
  if (!t) return;
  let active: string | null;
  try {
    active = await invoke<string | null>("ai_session_active", { dir });
  } catch {
    return;
  }
  if (!active || active === t.lastSession) return;
  const from = t.lastSession;
  t.lastSession = active;
  // (viewId, from→to, kind, time) 전이 레코드 — 복원 후 '어디서 분기되어 어떻게 흘렀는지' 재구성용.
  for (const viewId of t.viewIds) {
    await invoke("data_put", {
      ns: LINEAGE_NS,
      coll: LINEAGE_COLL,
      scope: t.cwd,
      id: null,
      doc: { viewId, fromSession: from, toSession: active, kind: "claude", time: Date.now() },
    }).catch(() => {});
  }
}

// claude 실행 시작(command.started) — cwd 세션 디렉토리 watch arm.
export async function startSessionTrack(viewId: string, cwd: string): Promise<void> {
  if (!cwd) return;
  let dir: string;
  try {
    dir = await invoke<string>("ai_session_dir", { cwd });
  } catch {
    return;
  }
  let t = byDir.get(dir);
  if (!t) {
    t = { viewIds: new Set(), lastSession: null, cwd };
    byDir.set(dir, t);
    await invoke("watch_dir", { path: dir }).catch(() => {});
  }
  t.viewIds.add(viewId);
  viewToDir.set(viewId, dir);
  ensureFsListener();
  await ensureDefined();
  // 시작 직후 1회 확정 — claude 가 막 첫 세션 파일을 쓰는 순간(이벤트 직후, 폴링 아님).
  await refresh(dir);
}

// claude 종료(command.finished) — watch disarm. 다른 viewId 가 같은 dir 을 안 쓰면 unwatch.
export async function stopSessionTrack(viewId: string): Promise<void> {
  const dir = viewToDir.get(viewId);
  if (!dir) return;
  viewToDir.delete(viewId);
  const t = byDir.get(dir);
  if (!t) return;
  t.viewIds.delete(viewId);
  if (t.viewIds.size === 0) {
    byDir.delete(dir);
    await invoke("ai_session_untrack", { dir }).catch(() => {});
    await invoke("unwatch_dir", { path: dir }).catch(() => {});
  }
}

// 이 viewId 가 지금 claude 세션을 추적 중인가(블록 agentKind 판정 — turn.ended 에서 재detect 불필요).
export function isTracking(viewId: string): boolean {
  return viewToDir.has(viewId);
}

// 이 viewId 의 현재 세션(watch 추적값) — turn.ended 가 블록에 실을 sessionId(find 폴링 대체).
export function currentSessionOf(viewId: string): string | null {
  const dir = viewToDir.get(viewId);
  return dir ? byDir.get(dir)?.lastSession ?? null : null;
}
