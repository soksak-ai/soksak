import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rafThrottle } from "../lib/rafThrottle";
import { emitPluginEvent } from "../plugins/hooks";
import { parkedStyle } from "../lib/layerPark";
import { commitViewVisibility } from "../lib/viewPark";
import { Icon } from "../ui/icons/Icon";
import { FileViewerHost } from "./FileViewerHost";
import { GroupStatusBar } from "./GroupStatusBar";
import { PluginViewHost } from "./PluginViewHost";
import { getRegisteredView } from "../plugins/viewRegistry";
import { ViewTabs } from "./ViewTabs";
import { computeSplitLayout, hitTestCells } from "./splitLayout";
import { useT } from "../i18n";
import { useTheme } from "../state/theme";
import { useUi } from "../state/ui";
import {
  type ContentArea,
  type DropZone,
  type GroupNode,
  type View,
  type ViewGroup,
  allGroups,
  useSessions,
  viewDisplayTitle,
} from "../state/sessions";
import { useHydration } from "../state/hydration";

// 콘텐츠 영역을 에디터 그룹으로 렌더. 핵심 원칙 둘:
// 1) 본문(터미널/에디터)을 그룹 트리 구조와 분리해 viewId 로 키된 "영속 본문 레이어"에
//    둔다 → 분할/이동/리사이즈로 트리가 바뀌어도 remount 없음(세션·에디터 완전 보존).
// 2) 드래그는 HTML5 DnD 가 아니라 포인터(mousedown/move/up)로 한다 — Tauri 네이티브
//    파일 drag-drop 과 충돌하지 않고(그건 외부 파일 전용) 실제로 동작하며, 드롭존·
//    인디케이터를 우리가 완전히 제어한다.
//
// 각 그룹 = [타이틀바(드래그=그룹 이동)] [탭바(탭 드래그=뷰 이동)] [본문] [스테이터스바].

export type Rect = { left: number; top: number; width: number; height: number }; // %
export interface Cell {
  group: ViewGroup;
  rect: Rect;
}
interface Divider {
  splitId: string;
  dir: "row" | "col";
  index: number;
  rect: Rect;
  spanPct: number;
  sizes: number[];
}

// 33 = 패딩4 + 칩24 + 패딩4 + 구분선1 — 내부(32)가 짝수라 칩도 짝수가 되고,
// 칩 안의 짝수 콘텐츠(아이콘 12/14, 닫기 16)까지 정수 센터링된다(절반픽셀 불가).
const HEADER_PX = 33;
const STATUS_PX = 24; // 스테이터스바 — 레퍼런스 24px
const CHROME_TOP = HEADER_PX; // 본문 상단 오프셋
const DRAG_THRESHOLD = 5; // 이 픽셀 이상 움직여야 드래그로 간주(아니면 클릭)

// paneStyle 토큰별 패널 간격(절반값 — 이웃 간 합산 10/12px, 레퍼런스 divider 실폭).
const PANE_INSET: Record<string, number> = { flat: 0, card: 5, floating: 6 };

// 최대화 시 셀/슬롯이 차지하는 전체 rect(컨텐츠 영역 기준 %).
const FULL_RECT = { left: 0, top: 0, width: 100, height: 100 };

// 콘텐츠 셀 레이아웃 = 공유 머신(computeSplitLayout). leaf 값(ViewGroup)을 cell.group 으로 매핑.
// [중복 제거] 좌측 사이드바와 동일한 레이아웃/히트테스트를 공유한다(splitLayout.ts).
export function computeLayout(node: GroupNode): {
  cells: Cell[];
  dividers: Divider[];
} {
  const { cells, dividers } = computeSplitLayout(node);
  return {
    cells: cells.map((c) => ({ group: c.value, rect: c.rect })),
    dividers,
  };
}

const titleOf = (v: View | undefined): string => (v ? viewDisplayTitle(v) : "");

// divider 리사이즈 드래그 중복 시작 가드. divider 가 네이티브 child 없는 gap 위면 실제 DOM mousedown
// 과, 코어 네이티브-마우스 브릿지(App.tsx)가 재생하는 합성 mousedown 이 둘 다 도착할 수 있다 — 먼저
// 온 하나만 드래그를 소유하고 나머지는 무시(window 리스너 이중 등록 방지). 한 번에 divider 하나만 드래그.
let resizeDragActive = false;

// 디바이더 드래그 제스처 사실을 두 소비자 계층에 알린다(코어는 의미를 모름 — 사실만):
// ① 플러그인 events 채널(layout.resize-gesture) — 이 창의 뷰 제공자(브라우저 플러그인 등)가
//    드래그 중 native bounds 커밋을 유예하고 freeze-frame 을 띄우는 근거.
// ② Rust 릴레이(webview_resize_gesture) — 코어 layer 밖의 엔진 사이드카(CEF) surface 에
//    같은 사실을 통지(webview_overlay_active 의 surface-occluded 패턴과 동형).
// resizeDragActive 가드 뒤에서만 호출되므로 시작/끝이 항상 짝을 이룬다.
function emitResizeGesture(active: boolean): void {
  emitPluginEvent("layout.resize-gesture", { active });
  void invoke("webview_resize_gesture", { active }).catch(() => {
    // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됨.
  });
}

// divider 안정 키(hover 강조 매칭용) — data-divider-key 로 노출, App 이 그 요소 rect 를 코어에 넘겨
// 네이티브 강조바를 브라우저 위에 그린다(seam=child 물림 방식은 밀림/리플로우라 폐기).
const dividerKey = (d: Divider): string => `${d.splitId}:${d.index}`;

// memo 경계 = content 데이터 경계(원칙 2): content X 의 store 쓰기는 content Y 의
// 객체 정체성을 보존(mapContent)하므로 다른 컨텐츠/프로젝트의 GroupArea 는 건너뛴다.
export const GroupArea = memo(function GroupArea({
  content,
  projectId,
  spaceShown = true,
}: {
  content: ContentArea;
  projectId: string;
  /** 이 스페이스(콘텐츠)가 활성인가 — 뷰 유효 가시성(스페이스 && 탭) 판정에 쓰인다. */
  spaceShown?: boolean;
}) {
  const t = useT();
  // B4 — 복원 hydration cold 집합 구독(평상시 빈 집합 → 리렌더 없음).
  const coldSet = useHydration((s) => s.cold);
  // 보이는 cold 뷰는 즉시 승격(렌더 중 set 금지 — effect). shown 판정과 동일 규칙.
  useEffect(() => {
    if (coldSet.size === 0) return;
    const maximizedId2 = content.maximizedViewId ?? null;
    for (const g of allGroups(content.layout)) {
      const visibleId = maximizedId2 ?? g.activeViewId;
      if (coldSet.has(visibleId)) useHydration.getState().promote(visibleId);
    }
  }, [coldSet, content]);
  // 분할 패널 헤더 = 탭 모드 고정(2026-06 결정 — 설정 비노출). title 모드 분기는
  // 재노출 대비 보존: 복원하려면 useSettings((s) => s.splitHeaderMode) 로 되돌린다.
  const splitHeaderMode = "tabs" as "title" | "tabs";
  // 구조 토큰 소비: paneStyle 에 따라 패널 간격(카드/플로팅은 실폭 디바이더).
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const inset = PANE_INSET[paneStyle] ?? 0;
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const setActiveView = useSessions((s) => s.setActiveView);
  const restoreView = useSessions((s) => s.restoreView);

  // 클릭 = 활성 + 실포커스 불변식. 상태 변경 effect 에만 의존하면 "이미 활성인
  // 그룹/pane 재클릭"이 no-op 인 채 mousedown 기본동작(비포커서블 클릭 → blur)
  // 만 남아 포커스가 body 로 풀리고, 풀린 뒤엔 그 그룹을 다시 클릭해도 복구할
  // 길이 없다(분할 직후 체감되는 "꺽쇠는 붙는데 입력이 안 가는" 사고). 그래서
  // 본문/탭/타이틀 클릭은 상태와 무관하게 항상 그 그룹의 focused pane 에 실포커스
  // 뷰 내부 포커스(터미널 등)는 플러그인 뷰가 마운트/활성 시 스스로 처리한다 — 코어는
  // 그룹 활성화만 한다(코어가 더 이상 터미널 host-div 를 소유하지 않음).
  const closeView = useSessions((s) => s.closeView);
  const moveViewToGroup = useSessions((s) => s.moveViewToGroup);
  const moveGroupToGroup = useSessions((s) => s.moveGroupToGroup);
  const resizeSplit = useSessions((s) => s.resizeSplit);
  const splitWithNewView = useSessions((s) => s.splitWithNewView);
  const pushOverlay = useUi((s) => s.pushOverlay);
  const popOverlay = useUi((s) => s.popOverlay);
  // 플러그인 뷰(콘텐츠 배치) 호스트에 넘길 프로젝트 루트.
  const projectRoot = useSessions(
    (s) => s.tabs.find((x) => x.id === projectId)?.root ?? null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ kind: "view" | "group"; id: string } | null>(
    null,
  );
  const [hover, setHover] = useState<{ groupId: string; zone: DropZone } | null>(
    null,
  );

  const { cells, dividers } = useMemo(
    () => computeLayout(content.layout),
    [content.layout],
  );
  // 최대화(maximizedViewId): 한 뷰가 컨텐츠 영역 전체를 차지. 분할 트리는
  // 불변 — 셀/프레임만 그 그룹 하나(전체 rect)로 바꿔 그리고, 나머지 그룹의
  // 슬롯은 숨김 유지(세션 보존: 터미널/webview 마운트는 절대 깨지 않는다).
  const maximizedId = content.maximizedViewId ?? null;
  const maxCell = maximizedId
    ? (cells.find((c) => c.group.views.some((v) => v.id === maximizedId)) ??
      null)
    : null;
  const displayCells = maxCell
    ? [{ group: maxCell.group, rect: FULL_RECT }]
    : cells;
  // 드래그 콜백들이 참조 안정(useCallback)을 유지하면서 최신 cells 를 읽기 위한 ref.
  // (클로저가 cells 를 직접 캡처하면 렌더마다 새 함수 → memo 경계가 깨진다)
  // 뷰 유효 가시성(스페이스 활성 && 탭 활성) 커밋 — 코어 단일 소유(lib/viewPark). 렌더 커밋 후(effect)
  // 실행이라 파킹 스타일이 이미 적용된 시점이고, commit 은 멱등이라 매 렌더 호출 비용은 변화 시에만.
  useEffect(() => {
    for (const { group } of cells) {
      for (const v of group.views) {
        const shown = maxCell ? v.id === maximizedId : v.id === group.activeViewId;
        commitViewVisibility(v.id, spaceShown && shown);
      }
    }
  });

  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // 포인터 좌표 → 어느 셀의 어느 zone 인지. 타이틀/탭/스테이터스 영역은 center(이동),
  // 본문 가장자리 ¼ 는 해당 방향 분할.
  // r 은 드래그 시작 시 1회 캡처한 컨테이너 rect — 탭 드래그 중 레이아웃은 정적이므로
  // 틱마다 getBoundingClientRect(강제 레이아웃)를 다시 읽지 않는다(원칙 5).
  // 히트테스트 = 공유 머신(hitTestCells). 콘텐츠 헤더(HEADER_PX)·상태바(STATUS_PX) 오프셋 주입.
  const hitTest = useCallback(
    (
      clientX: number,
      clientY: number,
      r: DOMRect,
      sourceGroupId?: string,
      selfCenterOnly = true,
    ): { groupId: string; zone: DropZone } | null => {
      const res = hitTestCells(
        clientX,
        clientY,
        r,
        cellsRef.current.map((c) => ({ value: c.group, rect: c.rect })),
        (g) => g.id,
        {
          chromeTop: CHROME_TOP,
          statusPx: STATUS_PX,
          sourceId: sourceGroupId,
          selfCenterOnly,
        },
      );
      return res ? { groupId: res.id, zone: res.zone } : null;
    },
    [],
  );

  // 포인터 드래그 시작(타이틀바=그룹, 탭=뷰). 임계 이상 움직이면 드래그, 아니면 클릭(전환).
  // 참조 안정(useCallback) — memo 된 ViewTabs 에 내려가도 경계를 깨지 않는다.
  const startDrag = useCallback(
    (kind: "view" | "group", id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // 탭/그룹 드래그가 에디터(.cm-content)·터미널 본문을 네이티브 선택으로 칠하지
      // 않도록 mousedown 시점에 선택을 원천 차단한다 — 이후 user-select 변경으로는
      // 이미 시작된 선택을 못 막는다(App.css .app-root 주석 참조). 클릭(탭 전환)은
      // mouseup 에서 처리하므로 영향 없다.
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const cells = cellsRef.current;
      // 드래그 출발 그룹(자기 영역 판정용): group=그 그룹, view=그 뷰가 속한 그룹.
      const sourceGroup =
        kind === "group"
          ? cells.find((c) => c.group.id === id)?.group
          : cells.find((c) => c.group.views.some((v) => v.id === id))?.group;
      const sourceGroupId = sourceGroup?.id;
      // 다중-뷰 그룹의 탭 드래그만 자기 영역 가장자리 분할 허용(탭 분리).
      const selfCenterOnly =
        kind === "group" || !sourceGroup || sourceGroup.views.length <= 1;
      let moved = false;
      let rect: DOMRect | null = null;
      // 호버 갱신은 프레임당 1회(원칙 4) + 같은 {그룹,존}이면 상태를 유지해
      // 존 경계를 넘을 때만 리렌더(없으면 mousemove 마다 서브트리 전체 리렌더).
      const updateHover = rafThrottle((x: number, y: number) => {
        const next = rect ? hitTest(x, y, rect, sourceGroupId, selfCenterOnly) : null;
        setHover((prev) =>
          prev?.groupId === next?.groupId && prev?.zone === next?.zone
            ? prev
            : next,
        );
      });
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
            return;
          moved = true;
          rect = containerRef.current?.getBoundingClientRect() ?? null;
          setDrag({ kind, id });
          // 드래그 = 오버레이(드롭 인디케이터가 브라우저 홀 위에도 그려진다).
          pushOverlay();
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        updateHover(ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        updateHover.cancel(); // 드롭 판정은 아래에서 직접 — 대기분은 버린다.
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          popOverlay();
          const target = rect
            ? hitTest(ev.clientX, ev.clientY, rect, sourceGroupId, selfCenterOnly)
            : null;
          if (target) {
            // 드롭 = 활성(스토어가 도착 그룹을 activeGroupId 로 만든다) — 활성은
            // 실포커스와 분리될 수 없다(클릭 분기와 동일 불변식). 분할 드롭은
            // 새 그룹이 생성되므로 결과의 groupId 로 포커스한다.
            if (kind === "view")
              moveViewToGroup(projectId, id, target.groupId, target.zone);
            else moveGroupToGroup(projectId, id, target.groupId, target.zone);
          }
        } else if (kind === "view") {
          setActiveView(projectId, id); // 클릭 = 탭 전환
        } else {
          setActiveGroup(projectId, id); // 클릭 = 그룹 활성
        }
        setDrag(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      projectId,
      hitTest,
      moveViewToGroup,
      moveGroupToGroup,
      setActiveView,
      setActiveGroup,
      pushOverlay,
      popOverlay,
    ],
  );

  // memo 된 ViewTabs 용 안정 콜백.
  const onTabPointerDown = useCallback(
    (viewId: string, e: React.MouseEvent) => startDrag("view", viewId)(e),
    [startDrag],
  );

  // 더블클릭 = 인접 두 영역을 정확히 반반으로(합 보존 — 다른 형제 비율 불변).
  const onDividerDoubleClick = (d: Divider) => () => {
    const sizes = [...d.sizes];
    const half = (sizes[d.index] + sizes[d.index + 1]) / 2;
    sizes[d.index] = half;
    sizes[d.index + 1] = half;
    resizeSplit(projectId, d.splitId, sizes);
  };

  const onDividerDown = (d: Divider) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (resizeDragActive) return; // 중복 시작(DOM + 네이티브 합성) 무시.
    const cont = containerRef.current;
    if (!cont) return;
    const contRect = cont.getBoundingClientRect();
    const totalPx = d.dir === "row" ? contRect.width : contRect.height;
    const splitPx = (totalPx * d.spanPct) / 100;
    if (splitPx <= 0) return;
    resizeDragActive = true; // 실제 드래그 개시 확정 후에만(위 early-return 은 잠그지 않음).
    emitResizeGesture(true);
    const startPos = d.dir === "row" ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const i = d.index;
    const minFrac = 0.08;
    // 스토어 커밋은 프레임당 1회 상한(원칙 3·4) — mousemove 는 60Hz 를 넘는다.
    const commitResize = rafThrottle((sizes: number[]) =>
      resizeSplit(projectId, d.splitId, sizes),
    );
    const onMove = (ev: MouseEvent) => {
      const cur = d.dir === "row" ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / splitPx;
      delta = Math.max(
        -(startSizes[i] - minFrac),
        Math.min(startSizes[i + 1] - minFrac, delta),
      );
      const sizes = [...startSizes];
      sizes[i] = startSizes[i] + delta;
      sizes[i + 1] = startSizes[i + 1] - delta;
      commitResize(sizes);
    };
    const onUp = () => {
      commitResize.flush(); // 리스너 제거 전에 — 마지막 프레임 유실 = 스냅백.
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizeDragActive = false;
      // flush(최종 레이아웃 커밋) 뒤에 종료를 알린다 — 구독자(브라우저 provider)는
      // 이 시점의 슬롯 rect 를 최종값으로 신뢰하고 bounds 를 1회 커밋한다.
      emitResizeGesture(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = d.dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const hoverCell = hover && cells.find((c) => c.group.id === hover.groupId);

  // 셀 좌표 — CSS 변수 4개만 전달하고 산수(calc)는 CSS 단일 규칙이 소유한다.
  // (좌표 문자열을 렌더마다 조립해 흩뿌리던 레거시 제거 — 치수 상수는 아래
  // 컨테이너에서 1회 주입되는 --header-h/--status-h/--pane-inset 이 단일 소스)
  const cellVars = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) =>
    ({
      "--l": `${rect.left}%`,
      "--t": `${rect.top}%`,
      "--w": `${rect.width}%`,
      "--h": `${rect.height}%`,
    }) as React.CSSProperties;

  return (
    <div
      className="egroup-area"
      ref={containerRef}
      style={
        {
          "--pane-inset": `${inset}px`,
          "--header-h": `${HEADER_PX}px`,
          "--status-h": `${STATUS_PX}px`,
        } as React.CSSProperties
      }
    >
      {/* ── 그룹 셀: 유일한 위치 지정 레이어(카드 배경/라운드 소유). 내부는
          flex column 정상 흐름 — [헤더][본문 공간][상태바]. 헤더/상태바 좌표
          산수는 존재하지 않는다. 본문 공간은 비워두고 영속 슬롯이 그 위에 뜬다. */}
      {displayCells.map(({ group, rect }) => {
        const isActiveGroup = group.id === content.activeGroupId;
        const active = group.views.find((v) => v.id === group.activeViewId);
        // 홀 셀(레이어 원칙): 활성 뷰 아래 네이티브 레이어(임베드 webview)가 비쳐야 하면 본문 영역에
        // 배경을 칠하면 안 된다 — CSS 가 헤더/상태바 밴드만 칠하도록 클래스로 표시. 데이터 주도:
        // transparent 선언 플러그인 콘텐츠 뷰(예: 브라우저 플러그인)만 홀로 처리(코어 하드 체크 없음).
        const holeCell =
          active?.kind === "plugin" &&
          !!getRegisteredView(`${active.pluginId}.${active.view}`)?.decl
            .transparent;
        return (
          <div
            key={`cell-${group.id}`}
            className={`egroup-cell${holeCell ? " cell-hole" : ""}`}
            style={cellVars(rect)}
          >
            {maxCell ? (
              /* 최대화 헤더: 탭·+ 대신 타이틀 — 더블클릭/버튼으로 원래 분할 복원 */
              <div
                className="egroup-title active"
                title={t("view.restoreHint")}
                onDoubleClick={() => restoreView(projectId)}
              >
                <span className="egt-icon icon-inline">
                  {active?.kind === "file" ? (
                    <Icon name="file" size="sm" />
                  ) : (
                    <Icon name="plugin" size="sm" />
                  )}
                </span>
                <span className="egt-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn egt-btn"
                  title={t("view.restore")}
                  onClick={() => restoreView(projectId)}
                >
                  <Icon name="minus" size="sm" />
                </button>
              </div>
            ) : splitHeaderMode === "tabs" ? (
              /* 탭 모드: 탭바(탭 드래그=뷰 이동, +=새 탭) */
              <div className="egroup-tabs">
                <ViewTabs
                  projectId={projectId}
                  group={group}
                  onTabPointerDown={onTabPointerDown}
                />
              </div>
            ) : (
              /* title 모드(현재 비노출 — 재노출 대비 보존): 바 전체=그룹 드래그 핸들 */
              <div
                className={`egroup-title${isActiveGroup ? " active" : ""}`}
                title={t("panel.move")}
                onMouseDown={startDrag("group", group.id)}
              >
                <span className="egt-icon icon-inline">
                  {active?.kind === "file" ? (
                    <Icon name="file" size="sm" />
                  ) : (
                    <Icon name="plugin" size="sm" />
                  )}
                </span>
                <span className="egt-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn egt-btn"
                  title={t("panel.split")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => splitWithNewView(projectId, group.id, "right")}
                >
                  <Icon name="split" size="sm" />
                </button>
                <button
                  type="button"
                  className="icon-btn egt-btn"
                  title={t("view.close")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeView(projectId, group.activeViewId)}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            )}
            <div className="egc-body-space" />
            <div className="egroup-status-wrap">
              <GroupStatusBar group={group} />
            </div>
          </div>
        );
      })}

      {/* ── 전경 프레임: 카드 보더(1px)를 모든 것 위에(불투명 터미널 포함) 보장.
          슬롯 레이어가 셀 보더를 덮기 때문에 보더만 분리해 띄운다(pointer-events
          none). 좌표는 셀과 동일한 변수 — 산수는 CSS 규칙이 소유.
          focus = 활성 그룹 표시(단일 그룹 포함 항상 — 사용자 결정).
          구조 경계선(--bd, §B 계약)은 불변 — 강조는 outline/배경(--acc, §B4)으로만.
          꺽쇠는 프레임 모서리 = 헤더/스테이터스 밴드 구간이라 네이티브 webview
          (본문 슬롯만 차지)에 가려지지 않는다. ── */}
      {displayCells.map(({ group, rect }) => (
        <div
          key={`frame-${group.id}`}
          className={`egroup-frame${
            group.id === content.activeGroupId ? " focus" : ""
          }`}
          style={cellVars(rect)}
        />
      ))}

      {/* ── 영속 본문 레이어: viewId 키 → 이동해도 remount 없음. 이 레이어만이
          위치 지정의 정당한 사유를 가진다(그룹 간 이동에도 CodeMirror/터미널
          세션 보존). 본문 영역 좌표는 CSS 규칙(셀 변수 + 치수 변수)이 계산. ── */}
      {cells.flatMap(({ group, rect }) =>
        group.views.map((view) => {
          // 최대화 중엔 최대화 뷰만 보인다(전체 rect) — 나머지는 숨김 유지.
          const shown = maxCell
            ? view.id === maximizedId
            : view.id === group.activeViewId;
          const slotRect = maxCell && shown ? FULL_RECT : rect;
          // B4 복원 hydration 게이트 — cold(복원됐지만 아직 안 보인) 뷰는 본문 마운트를
          // 미룬다(PTY 동시 spawn 분산). 보이는 순간·idle 체인이 승격한다. 평상시 cold 는
          // 빈 집합이라 게이트 비용 0. 슬롯 div 자체는 항상 렌더(원자적 외형·주소 안정).
          const hydrated = !coldSet.has(view.id) || shown;
          return (
            <div
              key={view.id}
              className="egroup-body-slot"
              // 네이티브 클릭 판정용(App.tsx native-mousedown → elementFromPoint).
              data-group-id={group.id}
              data-project-id={projectId}
              // 비활성 슬롯은 화면 밖으로 파킹(R12 단일 진실 parkedStyle) — WebGL 터미널 캔버스가 활성
              // 브라우저 홀로 비치는 것을 막는다. 콘텐츠 영역(App.tsx)과 동일 규칙·동일 헬퍼.
              style={{ ...cellVars(slotRect), ...parkedStyle(shown) }}
              onMouseDownCapture={() => {
                setActiveGroup(projectId, group.id);
              }}
            >
              {!hydrated ? null : view.kind === "file" ? (
                <FileViewerHost
                  path={view.path}
                  projectId={projectId}
                  root={projectRoot}
                  viewId={view.id}
                />
              ) : (
                <PluginViewHost
                  viewKey={`${view.pluginId}.${view.view}`}
                  viewId={view.id}
                  projectId={projectId}
                  root={projectRoot}
                  region="content"
                  command={view.command ?? null}
                  // B3 복원 seam — 관찰됐던 런타임(cwd·플러그인 state). 터미널은 spawn 위치,
                  // 브라우저류는 state(URL 등) 복원. 관찰값이 하나도 없으면 null(새 뷰).
                  restore={
                    view.cwd || view.state !== undefined
                      ? { cwd: view.cwd ?? null, state: view.state ?? null }
                      : null
                  }
                />
              )}
            </div>
          );
        }),
      )}

      {/* ── 리사이저(분할 경계 — 위치 지정이 본질인 요소). 최대화 중엔 경계 없음 ── */}
      {!maxCell &&
        dividers.map((d) => (
        <div
          key={`div-${d.splitId}-${d.index}`}
          data-divider-key={dividerKey(d)}
          data-node={`divider/${d.splitId}/${d.index}`}
          className={`egroup-divider ${d.dir}`}
          style={
            d.dir === "row"
              ? {
                  left: `${d.rect.left}%`,
                  top: `${d.rect.top}%`,
                  height: `${d.rect.height}%`,
                }
              : {
                  left: `${d.rect.left}%`,
                  top: `${d.rect.top}%`,
                  width: `${d.rect.width}%`,
                }
          }
          onMouseDown={onDividerDown(d)}
          onDoubleClick={onDividerDoubleClick(d)}
          title={t("divider.equalize")}
        />
      ))}

      {/* ── 드롭 인디케이터(드래그 중, 시각용) — 본문 영역 좌표는 CSS 규칙 소유 ── */}
      {drag && hover && hoverCell && (
        <div className="drop-ind-wrap" style={cellVars(hoverCell.rect)}>
          <div className={`drop-ind ${hover.zone}`} />
        </div>
      )}
    </div>
  );
});
