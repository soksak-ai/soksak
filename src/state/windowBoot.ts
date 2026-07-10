// 워크스페이스 영속 부트(A5) — main.tsx 부트가 1회 호출. core-kv 저장과 sessions 스토어를 잇는다.
//  1) 복원: "window/<label>" 스냅샷을 hydrate → 있으면 restoreProjects + reseed, 없으면 false 반환
//     (호출부가 bootstrapFirstProject 로 폴백).
//  2) 자동 저장: sessions 변경마다 디바운스로 스냅샷을 저장 + manifest upsert.
//  3) manifest: "windows" 키에 이 창(label) slot upsert.
//
// coreStore 가 localStorage 동기캐시 + app.data 권위·broadcast 를 흡수하므로 여기선 직렬화/배선만.

import { invoke } from "@tauri-apps/api/core";
import { safeListen } from "../lib/safeListen";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { currentWindowLabel } from "../lib/webviewLabels";
import { makeCoreStore } from "./coreStore";
import { validateProjectRoot, ensureDefaultProjectRoot } from "../lib/projectRoot";
import { claimRoots } from "./projectRegistry";
import { beginRestoreHydration } from "./hydration";
import { reseedSessionsSnapshot } from "../plugins/hooks";
import { listRecentProjects } from "./recentProjects";
import {
  useSessions,
  reseedIdCounters,
  nextSplitIdGen,
  migrateSpaceTitle,
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
} from "./windowPersistence";

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
  return safeListen<{ ns: string; id: string | null }>("data-change", (e) => {
    if (e.payload.ns === "core" && e.payload.id) cb(e.payload.id);
  });
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
export async function initWorkspacePersistence(
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
    const snap = await winStore.hydrate();
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
      const owned = tabs
        .filter((t) => !denied.has(t.root))
        // 로드-타임 마이그레이션 — 구 순수 숫자 스페이스 타이틀("3")을 "스페이스 3"(i18n)으로 승격(멱등,
        // 엑셀식 명명으로 스페이스임을 명확히). 사용자가 바꾼 타이틀은 보존(순수 숫자만 대상).
        .map((t) => ({
          ...t,
          contents: t.contents.map((c) => ({ ...c, title: migrateSpaceTitle(c.title) })),
        }));
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
        // 복원은 생성이 아니다(§5 재생≠관찰) — diff 기준점을 지금으로 재씨딩해 복원 델타가
        // project.created(→ 플러그인 git.init 자동 실행 등)로 오인 발화되는 것을 원천 차단.
        reseedSessionsSnapshot();
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
      // 창 라벨 불변식(NAMING 4b) — 런타임 창은 w-<uuid> 뿐이다. 다른 라벨은 capability 밖이라
      // 스폰하면 귀머거리 창(전 명령 TIMEOUT)이 된다. 스폰을 거부하고 데이터는 건드리지 않는다
      // — 구세대 데이터 교정은 일회용 마이그레이션(scripts/migrations/20260704-window-label-uuid.sh).
      if (!slot.label.startsWith("w-")) {
        console.error(
          `[restore] 구세대 라벨 slot 스폰 거부: ${slot.label} — ` +
            `scripts/migrations/20260704-window-label-uuid.sh 실행 필요(NAMING 4b)`,
        );
        continue;
      }
      await invoke("window_create", {
        label: slot.label,
        rect: slot.rect ?? null,
        // 백그라운드 복원 — 포커스를 뺏지 않는다. 오케스트레이터를 열면 오케스트레이터가 포커스를
        // 유지하고, 복원된 워크스페이스 창들은 뒤에 되살아난다(임의 포커스 이동 금지, 자연스러운 동작).
        focus: false,
      }).catch((e) => console.error(`창 리스폰 실패(${slot.label}):`, e));
    }
    if (pruned) await manifestStore.save(manifest);
    // 복원은 포커스를 옮기지 않는다 — 직전 포커스 창으로 강제 이동하던 로직 제거. 부팅 시 활성 창
    // (오케스트레이터 등)이 그대로 유지된다. 사용자가 원하면 창 목록의 포커스 아이콘으로 부른다.
    // 첫 실행(리스폰할 워크스페이스 slot 0 + 최근 프로젝트 0) — 기본 프로젝트 워크스페이스 창을
    // 하나 연다. 사용자가 창을 전부 닫아둔 경우(recents 존재)는 존중해 아무것도 열지 않는다.
    const hasSlots = manifest.slots.some((s) => s.label !== "main");
    if (!hasSlots) {
      const recents = await listRecentProjects().catch(() => []);
      if (recents.length === 0) {
        try {
          const root = await ensureDefaultProjectRoot("project1");
          await invoke("window_create", { init: `root=${encodeURIComponent(root)}` });
        } catch (e) {
          console.error("첫 실행 기본 워크스페이스 생성 실패:", e);
        }
      }
    }
  } catch (e) {
    console.error("멀티윈도우 리스폰 실패:", e);
  }
}

// 컨트롤 플레인(main) 프레임 영속 — 워크스페이스 manifest 와 분리된 자체 키. main 은 워크스페이스
// 스냅샷을 갖지 않으므로(오케스트레이터 전용) 프레임만 기억한다. 이동/리사이즈는 디바운스 저장.
export async function initControlPlaneFrame(): Promise<void> {
  const store = makeCoreStore<{ x: number; y: number; w: number; h: number } | null>({
    key: "controlPlaneFrame",
    lsKey: "soksak.controlPlaneFrame",
    fallback: null,
    ...coreStoreDeps,
  });
  try {
    const rect = await store.hydrate();
    if (rect) {
      const win = getCurrentWindow();
      await win.setPosition(new LogicalPosition(rect.x, rect.y)).catch(() => {});
      await win.setSize(new LogicalSize(rect.w, rect.h)).catch(() => {});
    }
  } catch (e) {
    console.error("컨트롤 플레인 프레임 복원 실패:", e);
  }
  const persist = debounce(() => {
    void currentFrame().then((f) => f && store.save(f));
  }, 400);
  void getCurrentWindow().onMoved(persist);
  void getCurrentWindow().onResized(persist);
}
