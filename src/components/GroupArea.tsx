import { memo, useCallback, useMemo, useRef, useState } from "react";
import { rafThrottle } from "../lib/rafThrottle";
import { Icon } from "../ui/icons/Icon";
import { BrowserView } from "./BrowserView";
import { FileViewer } from "./FileViewer";
import { GroupStatusBar } from "./GroupStatusBar";
import { PaneTree } from "./PaneTree";
import { PluginViewHost } from "./PluginViewHost";
import { ViewTabs } from "./ViewTabs";
import { useT } from "../i18n";
import { useTheme } from "../state/theme";
import { useUi } from "../state/ui";
import {
  type ContentArea,
  type DropZone,
  type GroupNode,
  type View,
  type ViewGroup,
  useSessions,
} from "../state/sessions";

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

export function computeLayout(node: GroupNode): {
  cells: Cell[];
  dividers: Divider[];
} {
  const cells: Cell[] = [];
  const dividers: Divider[] = [];
  const walk = (n: GroupNode, r: Rect) => {
    if (n.type === "leaf") {
      cells.push({ group: n.group, rect: r });
      return;
    }
    if (n.dir === "row") {
      let x = r.left;
      n.children.forEach((c, i) => {
        const w = r.width * n.sizes[i];
        walk(c, { left: x, top: r.top, width: w, height: r.height });
        x += w;
        if (i < n.children.length - 1) {
          dividers.push({
            splitId: n.id,
            dir: "row",
            index: i,
            rect: { left: x, top: r.top, width: 0, height: r.height },
            spanPct: r.width,
            sizes: n.sizes,
          });
        }
      });
    } else {
      let y = r.top;
      n.children.forEach((c, i) => {
        const h = r.height * n.sizes[i];
        walk(c, { left: r.left, top: y, width: r.width, height: h });
        y += h;
        if (i < n.children.length - 1) {
          dividers.push({
            splitId: n.id,
            dir: "col",
            index: i,
            rect: { left: r.left, top: y, width: r.width, height: 0 },
            spanPct: r.height,
            sizes: n.sizes,
          });
        }
      });
    }
  };
  walk(node, { left: 0, top: 0, width: 100, height: 100 });
  return { cells, dividers };
}

const titleOf = (
  v: View | undefined,
  term: string,
): string => (v ? (v.kind === "terminal" ? term : v.title) : "");

// memo 경계 = content 데이터 경계(원칙 2): content X 의 store 쓰기는 content Y 의
// 객체 정체성을 보존(mapContent)하므로 다른 컨텐츠/프로젝트의 GroupArea 는 건너뛴다.
export const GroupArea = memo(function GroupArea({
  content,
  projectId,
  isActiveProject,
  isDark,
}: {
  content: ContentArea;
  projectId: string;
  isActiveProject: boolean;
  isDark: boolean;
}) {
  const t = useT();
  // 분할 패널 헤더 = 탭 모드 고정(2026-06 결정 — 설정 비노출). title 모드 분기는
  // 재노출 대비 보존: 복원하려면 useSettings((s) => s.splitHeaderMode) 로 되돌린다.
  const splitHeaderMode = "tabs" as "title" | "tabs";
  // 구조 토큰 소비: paneStyle 에 따라 패널 간격(카드/플로팅은 실폭 디바이더).
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const inset = PANE_INSET[paneStyle] ?? 0;
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const setActiveView = useSessions((s) => s.setActiveView);
  const closeView = useSessions((s) => s.closeView);
  const moveViewToGroup = useSessions((s) => s.moveViewToGroup);
  const moveGroupToGroup = useSessions((s) => s.moveGroupToGroup);
  const resizeSplit = useSessions((s) => s.resizeSplit);
  const splitWithNewView = useSessions((s) => s.splitWithNewView);
  const suppressBrowser = useUi((s) => s.suppressBrowser);
  const releaseBrowser = useUi((s) => s.releaseBrowser);
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
  // 드래그 콜백들이 참조 안정(useCallback)을 유지하면서 최신 cells 를 읽기 위한 ref.
  // (클로저가 cells 를 직접 캡처하면 렌더마다 새 함수 → memo 경계가 깨진다)
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // 포인터 좌표 → 어느 셀의 어느 zone 인지. 타이틀/탭/스테이터스 영역은 center(이동),
  // 본문 가장자리 ¼ 는 해당 방향 분할.
  // r 은 드래그 시작 시 1회 캡처한 컨테이너 rect — 탭 드래그 중 레이아웃은 정적이므로
  // 틱마다 getBoundingClientRect(강제 레이아웃)를 다시 읽지 않는다(원칙 5).
  const hitTest = useCallback(
    (
      clientX: number,
      clientY: number,
      r: DOMRect,
      sourceGroupId?: string,
      selfCenterOnly = true,
    ) => {
    const cells = cellsRef.current;
    const xPct = ((clientX - r.left) / r.width) * 100;
    const yPct = ((clientY - r.top) / r.height) * 100;
    const cell = cells.find(
      (c) =>
        xPct >= c.rect.left &&
        xPct <= c.rect.left + c.rect.width &&
        yPct >= c.rect.top &&
        yPct <= c.rect.top + c.rect.height,
    );
    if (!cell) return null;
    // 자기 출발 그룹 위: 그룹 드래그나 단일-뷰 탭은 항상 center(분할 무의미). 다중-뷰
    // 그룹의 탭 드래그는 본문 가장자리에 떨어뜨려 그 탭만 새 패널로 분리할 수 있게 통과.
    if (cell.group.id === sourceGroupId && selfCenterOnly) {
      return { groupId: cell.group.id, zone: "center" as DropZone };
    }
    const cellTopPx = r.top + (cell.rect.top / 100) * r.height;
    const cellHpx = (cell.rect.height / 100) * r.height;
    const cellLeftPx = r.left + (cell.rect.left / 100) * r.width;
    const cellWpx = (cell.rect.width / 100) * r.width;
    const localY = clientY - cellTopPx;
    const bodyTop = CHROME_TOP;
    const bodyBottom = cellHpx - STATUS_PX;
    if (localY < bodyTop || localY > bodyBottom || bodyBottom <= bodyTop) {
      return { groupId: cell.group.id, zone: "center" as DropZone };
    }
    const px = (clientX - cellLeftPx) / cellWpx;
    const py = (localY - bodyTop) / (bodyBottom - bodyTop);
    const edge = 0.25;
    if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) {
      return { groupId: cell.group.id, zone: "center" as DropZone };
    }
    const dl = px;
    const dr = 1 - px;
    const dt = py;
    const db = 1 - py;
    const m = Math.min(dl, dr, dt, db);
    const zone: DropZone =
      m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
    return { groupId: cell.group.id, zone };
    },
    [],
  );

  // 포인터 드래그 시작(타이틀바=그룹, 탭=뷰). 임계 이상 움직이면 드래그, 아니면 클릭(전환).
  // 참조 안정(useCallback) — memo 된 ViewTabs 에 내려가도 경계를 깨지 않는다.
  const startDrag = useCallback(
    (kind: "view" | "group", id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
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
          // 드롭 인디케이터는 DOM — 네이티브 브라우저 webview 에 가리므로 잠시 숨김.
          suppressBrowser();
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
          releaseBrowser();
          const target = rect
            ? hitTest(ev.clientX, ev.clientY, rect, sourceGroupId, selfCenterOnly)
            : null;
          if (target) {
            if (kind === "view") {
              moveViewToGroup(projectId, id, target.groupId, target.zone);
            } else {
              moveGroupToGroup(projectId, id, target.groupId, target.zone);
            }
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
      suppressBrowser,
      releaseBrowser,
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
    const cont = containerRef.current;
    if (!cont) return;
    const contRect = cont.getBoundingClientRect();
    const totalPx = d.dir === "row" ? contRect.width : contRect.height;
    const splitPx = (totalPx * d.spanPct) / 100;
    if (splitPx <= 0) return;
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
      {cells.map(({ group, rect }) => {
        const isActiveGroup = group.id === content.activeGroupId;
        const active = group.views.find((v) => v.id === group.activeViewId);
        return (
          <div
            key={`cell-${group.id}`}
            className="egroup-cell"
            style={cellVars(rect)}
          >
            {splitHeaderMode === "tabs" ? (
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
                title={t("group.move")}
                onMouseDown={startDrag("group", group.id)}
              >
                <span className="egt-icon icon-inline">
                  {active?.kind === "terminal" ? (
                    <Icon name="terminal" size="sm" />
                  ) : active?.kind === "file" ? (
                    <Icon name="file" size="sm" />
                  ) : (
                    <Icon name="browser" size="sm" />
                  )}
                </span>
                <span className="egt-name">
                  {titleOf(active, t("view.terminal"))}
                </span>
                <button
                  type="button"
                  className="icon-btn egt-btn"
                  title={t("group.split")}
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
      {cells.map(({ group, rect }) => (
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
          const isActiveView = view.id === group.activeViewId;
          return (
            <div
              key={view.id}
              className="egroup-body-slot"
              style={{
                ...cellVars(rect),
                visibility: isActiveView ? "visible" : "hidden",
                zIndex: isActiveView ? 1 : 0,
              }}
              onMouseDownCapture={() => setActiveGroup(projectId, group.id)}
            >
              {view.kind === "terminal" ? (
                <PaneTree
                  node={view.layout}
                  projectId={projectId}
                  viewId={view.id}
                  active={isActiveProject && isActiveView}
                  focusedPaneId={view.focusedPaneId}
                />
              ) : view.kind === "file" ? (
                <FileViewer
                  path={view.path}
                  mode={view.mode}
                  isDark={isDark}
                  projectId={projectId}
                  viewId={view.id}
                />
              ) : view.kind === "plugin" ? (
                <PluginViewHost
                  viewKey={`${view.pluginId}.${view.view}`}
                  projectId={projectId}
                  root={projectRoot}
                />
              ) : (
                <BrowserView
                  projectId={projectId}
                  viewId={view.id}
                  url={view.url}
                  visible={isActiveProject && isActiveView}
                />
              )}
            </div>
          );
        }),
      )}

      {/* ── 리사이저(분할 경계 — 위치 지정이 본질인 요소) ── */}
      {dividers.map((d) => (
        <div
          key={`div-${d.splitId}-${d.index}`}
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
