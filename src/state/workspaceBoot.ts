// 워크스페이스 영속 부트(A5) — main.tsx 부트가 1회 호출. core-kv 저장과 sessions 스토어를 잇는다.
//  1) 복원: "window/<label>" 스냅샷을 hydrate → 있으면 restoreProjects + reseed, 없으면 false 반환
//     (호출부가 bootstrapFirstProject 로 폴백).
//  2) 자동 저장: sessions 변경마다 디바운스로 스냅샷을 저장 + manifest upsert.
//  3) manifest: "windows" 키에 이 창(label) slot upsert.
//
// coreStore 가 localStorage 동기캐시 + app.data 권위·broadcast 를 흡수하므로 여기선 직렬화/배선만.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentWindowLabel } from "../lib/webviewLabels";
import { makeCoreStore } from "./coreStore";
import { claimRoots } from "./projectRegistry";
import {
  useSessions,
  reseedIdCounters,
  nextSplitIdGen,
  type ProjectTab,
} from "./sessions";
import {
  snapshotWindow,
  restoreWindow,
  windowManifestEntry,
  upsertManifest,
  type WindowSnapshot,
  type WindowManifest,
} from "./workspacePersistence";

// core ns data-change → coreStore 가 기대하는 (key)=>void. kv 키는 페이로드 id 필드.
function coreOnDataChange(cb: (key: string) => void): () => void {
  let un = () => {};
  let disposed = false;
  void listen<{ ns: string; id: string | null }>("data-change", (e) => {
    if (e.payload.ns === "core" && e.payload.id) cb(e.payload.id);
  }).then((u) => {
    if (disposed) u();
    else un = u;
  });
  return () => {
    disposed = true;
    un();
  };
}

// core kv 저장 의존성(invoke/data-change/ls) — viewLabels 등 다른 core 영속 상태도 공유.
export const coreStoreDeps = {
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
  onDataChange: coreOnDataChange,
  localStorage: window.localStorage,
};

const EMPTY_WINDOW: WindowSnapshot = { activeId: "", projects: [] };
const EMPTY_MANIFEST: WindowManifest = { slots: [] };

function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let h: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
}

// 부트 1회. 복원 성공 시 true(호출부는 bootstrap 생략), 없으면 false(호출부 폴백).
export async function initWorkspacePersistence(): Promise<boolean> {
  const label = currentWindowLabel();
  const winStore = makeCoreStore<WindowSnapshot>({
    key: `window/${label}`,
    lsKey: `soksak.window.${label}`,
    fallback: EMPTY_WINDOW,
    ...coreStoreDeps,
  });
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });

  // 1) 복원
  let restored = false;
  try {
    const snap = await winStore.hydrate();
    if (snap.projects.length > 0) {
      const { tabs, activeId } = restoreWindow(snap, nextSplitIdGen);
      // P6(전역 단일 오픈): 이 창 스냅샷의 root 들을 일괄 점유. 다른 창이 이미 점유한
      // root 의 탭은 이 창에서 드롭한다(같은 프로젝트 중복 창 금지 — 우아한 열화).
      const denied = await claimRoots(tabs.map((t) => t.root));
      const owned = tabs.filter((t) => !denied.has(t.root));
      for (const t of tabs) {
        if (denied.has(t.root))
          console.warn(`[P6] 복원 탭 드롭(다른 창 점유): ${t.root}`);
      }
      const active = owned.some((t) => t.id === activeId)
        ? activeId
        : (owned[0]?.id ?? "");
      reseedIdCounters(owned);
      if (owned.length > 0) {
        useSessions.getState().restoreProjects(owned, active);
      }
      restored = useSessions.getState().tabs.length > 0;
    }
  } catch (e) {
    console.error("워크스페이스 복원 실패 — 기본 부트로 폴백:", e);
  }

  // 2) 자동 저장 — 변경마다 디바운스(빠른 연속 변경 1회 저장).
  const persist = debounce(() => {
    const { tabs, activeId } = useSessions.getState();
    void persistNow(label, tabs, activeId, winStore, manifestStore);
  }, 400);
  useSessions.subscribe(persist);

  return restored;
}

async function persistNow(
  label: string,
  tabs: ProjectTab[],
  activeId: string,
  winStore: ReturnType<typeof makeCoreStore<WindowSnapshot>>,
  manifestStore: ReturnType<typeof makeCoreStore<WindowManifest>>,
): Promise<void> {
  try {
    await winStore.save(snapshotWindow(tabs, activeId));
    const manifest = await manifestStore.hydrate();
    await manifestStore.save(
      upsertManifest(manifest, windowManifestEntry(label, tabs, activeId)),
    );
  } catch (e) {
    console.error("워크스페이스 저장 실패:", e);
  }
}
