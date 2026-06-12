import { useMemo, useRef, useState } from "react";
import { BrowserView } from "./BrowserView";
import { FileViewer } from "./FileViewer";
import { GroupStatusBar } from "./GroupStatusBar";
import { PaneTree } from "./PaneTree";
import { PluginViewHost } from "./PluginViewHost";
import { ViewTabs } from "./ViewTabs";
import { useT } from "../i18n";
import { useSettings } from "../state/settings";
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

const HEADER_PX = 32; // 헤더(타이틀바 또는 탭바) 한 줄 — 레퍼런스 패널 탭바 32px
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

export function GroupArea({
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
  const splitHeaderMode = useSettings((s) => s.splitHeaderMode);
  // 구조 토큰 소비: paneStyle 에 따라 패널 간격(카드/플로팅은 실폭 디바이더).
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const inset = PANE_INSET[paneStyle] ?? 0;
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const setActiveView = useSessions((s) => s.setActiveView);
  const setFileMode = useSessions((s) => s.setFileMode);
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

  // 포인터 좌표 → 어느 셀의 어느 zone 인지. 타이틀/탭/스테이터스 영역은 center(이동),
  // 본문 가장자리 ¼ 는 해당 방향 분할.
  const hitTest = (
    clientX: number,
    clientY: number,
    sourceGroupId?: string,
    selfCenterOnly = true,
  ) => {
    const cont = containerRef.current;
    if (!cont) return null;
    const r = cont.getBoundingClientRect();
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
  };

  // 포인터 드래그 시작(타이틀바=그룹, 탭=뷰). 임계 이상 움직이면 드래그, 아니면 클릭(전환).
  const startDrag =
    (kind: "view" | "group", id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
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
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
            return;
          moved = true;
          setDrag({ kind, id });
          // 드롭 인디케이터는 DOM — 네이티브 브라우저 webview 에 가리므로 잠시 숨김.
          suppressBrowser();
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        setHover(hitTest(ev.clientX, ev.clientY, sourceGroupId, selfCenterOnly));
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          releaseBrowser();
          const target = hitTest(
            ev.clientX,
            ev.clientY,
            sourceGroupId,
            selfCenterOnly,
          );
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
      resizeSplit(projectId, d.splitId, sizes);
    };
    const onUp = () => {
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

  return (
    <div className="egroup-area" ref={containerRef}>
      {/* ── 백킹 카드 레이어(레퍼런스 SKIN.pane): 패널 전체(타이틀+본문+상태)를
          overflow:hidden 단일 카드 하나로 감싼다. card/floating 만 보더·배경,
          flat 은 투명. 가장 아래(맨 먼저 렌더)에 깔려 본문/chrome 이 위에 얹힌다. */}
      {cells.map(({ group, rect }) => (
        <div
          key={`card-${group.id}`}
          className="egroup-card"
          style={{
            left: `calc(${rect.left}% + ${inset}px)`,
            top: `calc(${rect.top}% + ${inset}px)`,
            width: `calc(${rect.width}% - ${inset * 2}px)`,
            height: `calc(${rect.height}% - ${inset * 2}px)`,
          }}
        />
      ))}

      {/* ── 전경 프레임 레이어: 카드 보더(1px) 를 모든 것 위에(터미널 포함) 그린다.
          백킹 카드 보더는 불투명 터미널에 가려 좌우/하단이 사라지므로, 보더만 분리해
          오버레이로 띄운다(pointer-events:none). 4면 단일 1px 프레임 보장. ── */}
      {cells.map(({ group, rect }) => (
        <div
          key={`frame-${group.id}`}
          className="egroup-frame"
          style={{
            left: `calc(${rect.left}% + ${inset}px)`,
            top: `calc(${rect.top}% + ${inset}px)`,
            width: `calc(${rect.width}% - ${inset * 2}px)`,
            height: `calc(${rect.height}% - ${inset * 2}px)`,
          }}
        />
      ))}

      {/* ── 영속 본문 레이어: viewId 키 → 이동해도 remount 없음 ── */}
      {cells.flatMap(({ group, rect }) =>
        group.views.map((view) => {
          const isActiveView = view.id === group.activeViewId;
          return (
            <div
              key={view.id}
              className="egroup-body-slot"
              style={{
                left: `calc(${rect.left}% + ${inset}px)`,
                top: `calc(${rect.top}% + ${inset + CHROME_TOP}px)`,
                width: `calc(${rect.width}% - ${inset * 2}px)`,
                height: `calc(${rect.height}% - ${inset * 2 + CHROME_TOP + STATUS_PX}px)`,
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
                  onMode={(m) => setFileMode(projectId, view.id, m)}
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

      {/* ── 그룹 chrome: 헤더(모드별 타이틀바/탭바) + 스테이터스바 ── */}
      {cells.map(({ group, rect }) => {
        const isActiveGroup = group.id === content.activeGroupId;
        const active = group.views.find((v) => v.id === group.activeViewId);
        return (
          <div key={`chrome-${group.id}`}>
            {splitHeaderMode === "tabs" ? (
              /* 탭 모드: 탭바(탭 드래그=뷰 이동, +=새 탭) */
              <div
                className="egroup-tabs"
                style={{
                  left: `calc(${rect.left}% + ${inset}px)`,
                  top: `calc(${rect.top}% + ${inset}px)`,
                  width: `calc(${rect.width}% - ${inset * 2}px)`,
                  height: HEADER_PX,
                }}
              >
                <ViewTabs
                  projectId={projectId}
                  group={group}
                  onTabPointerDown={(viewId, e) => startDrag("view", viewId)(e)}
                />
              </div>
            ) : (
              /* 기본 title 모드: 타이틀바(바 전체=그룹 드래그 핸들) + 분할/닫기 버튼 */
              <div
                className={`egroup-title${isActiveGroup ? " active" : ""}`}
                style={{
                  left: `calc(${rect.left}% + ${inset}px)`,
                  top: `calc(${rect.top}% + ${inset}px)`,
                  width: `calc(${rect.width}% - ${inset * 2}px)`,
                  height: HEADER_PX,
                }}
                title={t("group.move")}
                onMouseDown={startDrag("group", group.id)}
              >
                <span className="egt-icon">
                  {active?.kind === "terminal"
                    ? "›_"
                    : active?.kind === "file"
                      ? "▤"
                      : "◍"}
                </span>
                <span className="egt-name">
                  {titleOf(active, t("view.terminal"))}
                </span>
                <button
                  type="button"
                  className="egt-btn"
                  title={t("group.split")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => splitWithNewView(projectId, group.id, "right")}
                >
                  ⊟
                </button>
                <button
                  type="button"
                  className="egt-btn"
                  title={t("view.close")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeView(projectId, group.activeViewId)}
                >
                  ×
                </button>
              </div>
            )}
            {/* 스테이터스바(셀 하단) */}
            <div
              className="egroup-status-wrap"
              style={{
                left: `calc(${rect.left}% + ${inset}px)`,
                top: `calc(${rect.top + rect.height}% - ${STATUS_PX + inset}px)`,
                width: `calc(${rect.width}% - ${inset * 2}px)`,
                height: STATUS_PX,
              }}
            >
              <GroupStatusBar group={group} />
            </div>
          </div>
        );
      })}

      {/* ── 리사이저 ── */}
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
        />
      ))}

      {/* ── 드롭 인디케이터(드래그 중, 시각용) ── */}
      {drag && hover && hoverCell && (
        <div
          className="drop-ind-wrap"
          style={{
            left: `${hoverCell.rect.left}%`,
            top: `calc(${hoverCell.rect.top}% + ${CHROME_TOP}px)`,
            width: `${hoverCell.rect.width}%`,
            height: `calc(${hoverCell.rect.height}% - ${CHROME_TOP + STATUS_PX}px)`,
          }}
        >
          <div className={`drop-ind ${hover.zone}`} />
        </div>
      )}
    </div>
  );
}
