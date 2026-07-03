// 워크스페이스 영속 부트(A5) — main.tsx 부트가 1회 호출. core-kv 저장과 sessions 스토어를 잇는다.
//  1) 복원: "window/<label>" 스냅샷을 hydrate → 있으면 restoreProjects + reseed, 없으면 false 반환
//     (호출부가 bootstrapFirstProject 로 폴백).
//  2) 자동 저장: sessions 변경마다 디바운스로 스냅샷을 저장 + manifest upsert.
//  3) manifest: "windows" 키에 이 창(label) slot upsert.
//
// coreStore 가 localStorage 동기캐시 + app.data 권위·broadcast 를 흡수하므로 여기선 직렬화/배선만.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { currentWindowLabel } from "../lib/webviewLabels";
import { makeCoreStore } from "./coreStore";
import { validateProjectRoot } from "../lib/workspace";
import { claimRoots } from "./projectRegistry";
import { beginRestoreHydration } from "./hydration";
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
  setManifestFocused,
  type WindowSnapshot,
  type WindowManifest,
} from "./workspacePersistence";

// 이 창의 프레임(논리 px) — manifest rect 기록용. 실패는 rect 생략(복원은 OS 기본 위치).
async function currentFrame(): Promise<
  { x: number; y: number; w: number; h: number } | undefined
> {
  try {
    const win = getCurrentWindow();
    const [pos, size, scale] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    return {
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      w: Math.round(size.width / scale),
      h: Math.round(size.height / scale),
    };
  } catch {
    return undefined;
  }
}

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
// skipRestore: 런타임 새 창(fresh=1) — 라벨 재사용의 유령 복원 차단(자동 저장만 켠다).
export async function initWorkspacePersistence(
  opts: { skipRestore?: boolean } = {},
): Promise<boolean> {
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
    const snap = opts.skipRestore ? EMPTY_WINDOW : await winStore.hydrate();
    if (snap.projects.length > 0) {
      const { tabs, activeId } = restoreWindow(snap, nextSplitIdGen);
      // root 존재 검증 — 부재/무효 root 는 탭을 지우지 않고 rootMissing 으로 격하한다
      // (무단 삭제 금지). 배너가 알리고, 경로가 돌아오면 다음 복원에서 자연 해소.
      await Promise.all(
        tabs.map(async (t) => {
          try {
            await validateProjectRoot(t.root);
          } catch {
            t.rootMissing = true;
            console.warn(`[restore] 프로젝트 root 부재 — 격하 탭으로 복원: ${t.root}`);
          }
        }),
      );
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
        // B4 — 복원 hydration: 보이지 않는 복원 뷰의 본문 마운트를 미루고(PTY 동시
        // spawn 분산), idle 체인이 lastActivity 순으로 채운다. 외형은 즉시 전부.
        beginRestoreHydration();
      }
      restored = useSessions.getState().tabs.length > 0;
    }
  } catch (e) {
    console.error("워크스페이스 복원 실패 — 기본 부트로 폴백:", e);
  }

  // 2) 자동 저장 — 변경마다 디바운스(빠른 연속 변경 1회 저장). pagehide(창 닫힘·앱 종료
  // 직전)에 잔여 기록을 즉시 flush — 디바운스 창(≤400ms) 내 종료의 마지막 변경 유실 방지
  // (coreSync.ts 와 동일 패턴 — B1 정합성: 저장은 종료 시 flush 보장).
  const doPersist = () => {
    const { tabs, activeId } = useSessions.getState();
    void persistNow(label, tabs, activeId, winStore, manifestStore);
  };
  const persist = debounce(doPersist, 400);
  useSessions.subscribe(persist);
  window.addEventListener("pagehide", doPersist);
  // 창 이동/리사이즈도 저장 트리거(B2 rect) — sessions 변화가 아니라 위 구독이 못 잡는다.
  // 네이티브 이벤트 기반(폴링 0), 같은 디바운스로 coalesce.
  void getCurrentWindow().onMoved(persist);
  void getCurrentWindow().onResized(persist);

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
    // 창 프레임(B2) — 리스폰이 같은 자리·크기로 되살린다(듀얼 모니터 배치 유지).
    const entry = { ...windowManifestEntry(label, tabs, activeId), rect: await currentFrame() };
    let next = upsertManifest(manifest, entry);
    // 마지막 포커스 창(B2) — 재시작 후 그 창을 앞으로.
    if (document.hasFocus()) next = setManifestFocused(next, label);
    await manifestStore.save(next);
  } catch (e) {
    console.error("워크스페이스 저장 실패:", e);
  }
}

// 멀티윈도우 리스폰(B2) — main 창 부트가 1회 호출: manifest 의 다른 slot 창들을 라벨 그대로
// 되살린다(각 창은 자기 스냅샷을 스스로 복원). 스냅샷 없는 유령 slot(B1 이전 잔재·수동 삭제)은
// 건너뛰고 manifest 에서 정리한다. 스폰이 포커스를 차례로 뺏으므로, 마지막에 focusedLabel 을
// 1회 포커스해 사용자가 마지막으로 보던 창이 앞으로 온다.
export async function respawnSavedWindows(): Promise<void> {
  if (currentWindowLabel() !== "main") return; // 리스폰 소유자는 main 부트 하나(멱등 가드)
  const manifestStore = makeCoreStore<WindowManifest>({
    key: "windows",
    lsKey: "soksak.windows",
    fallback: EMPTY_MANIFEST,
    ...coreStoreDeps,
  });
  try {
    let manifest = await manifestStore.hydrate();
    let pruned = false;
    for (const slot of manifest.slots.filter((s) => s.label !== "main")) {
      const snapStore = makeCoreStore<WindowSnapshot>({
        key: `window/${slot.label}`,
        lsKey: `soksak.window.${slot.label}`,
        fallback: EMPTY_WINDOW,
        ...coreStoreDeps,
      });
      const snap = await snapStore.hydrate();
      if (snap.projects.length === 0) {
        manifest = upsertManifest(manifest, { ...slot, roots: [] }); // slot 제거
        pruned = true;
        console.warn(`[restore] 유령 slot 정리(스냅샷 없음): ${slot.label}`);
        continue;
      }
      await invoke("window_create", {
        label: slot.label,
        rect: slot.rect ?? null,
      }).catch((e) => console.error(`창 리스폰 실패(${slot.label}):`, e));
    }
    if (pruned) await manifestStore.save(manifest);
    // main 자신의 프레임 복원 + 마지막 포커스 창 전면.
    const mainSlot = manifest.slots.find((s) => s.label === "main");
    if (mainSlot?.rect) {
      const win = getCurrentWindow();
      await win.setPosition(new LogicalPosition(mainSlot.rect.x, mainSlot.rect.y)).catch(() => {});
      await win.setSize(new LogicalSize(mainSlot.rect.w, mainSlot.rect.h)).catch(() => {});
    }
    if (manifest.focusedLabel) {
      await invoke("window_focus", { label: manifest.focusedLabel }).catch(() => {});
    }
  } catch (e) {
    console.error("멀티윈도우 리스폰 실패:", e);
  }
}
