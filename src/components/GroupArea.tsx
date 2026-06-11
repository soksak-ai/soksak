import { useMemo, useRef, useState } from "react";
import { FileViewer } from "./FileViewer";
import { PaneTree } from "./PaneTree";
import { ViewTabs } from "./ViewTabs";
import {
  type DropZone,
  type GroupNode,
  type ProjectTab,
  type View,
  type ViewGroup,
  useSessions,
} from "../state/sessions";

// 콘텐츠 영역을 editor 에디터 그룹처럼 렌더. 핵심 원칙: 본문(터미널/에디터)을 그룹 트리
// 구조와 분리해 viewId 로 키된 "영속 본문 레이어"에 둔다. 그룹 chrome(탭바·드롭존)과
// 본문이 별개 레이어이므로, 분할/이동/리사이즈로 트리가 바뀌어도 본문의 React 정체성이
// 유지되어 remount 가 일어나지 않는다 → 터미널 PTY·xterm, 에디터 undo/커서/스크롤까지
// 완전 보존된다(우회 캐시 불필요). 각 그룹·본문은 트리에서 계산한 사각형(%)으로 배치.

type Rect = { left: number; top: number; width: number; height: number }; // %
interface Cell {
  group: ViewGroup;
  rect: Rect;
}
interface Divider {
  splitId: string;
  dir: "row" | "col";
  index: number;
  rect: Rect;
  spanPct: number; // split 이 dir 축으로 차지하는 컨테이너 비율(%)
  sizes: number[];
}

const TAB_BAR_PX = 32; // 탭 바 높이(본문 오프셋·드롭존 판정 기준). CSS .view-tabs-wrap 와 일치.

function computeLayout(node: GroupNode): { cells: Cell[]; dividers: Divider[] } {
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

// 커서 위치 → 드롭 zone. 탭 바 영역은 center(그룹으로 이동), 본문은 가장자리 1/4 분할.
function zoneFromEvent(e: React.DragEvent, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const yTop = e.clientY - r.top;
  if (yTop < TAB_BAR_PX) return "center";
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - (r.top + TAB_BAR_PX)) / (r.height - TAB_BAR_PX);
  const edge = 0.25;
  if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) return "center";
  const dl = px;
  const dr = 1 - px;
  const dt = py;
  const db = 1 - py;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return "left";
  if (m === dr) return "right";
  if (m === dt) return "top";
  return "bottom";
}

export function GroupArea({
  project,
  isActiveProject,
  isDark,
}: {
  project: ProjectTab;
  isActiveProject: boolean;
  isDark: boolean;
}) {
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const setFileMode = useSessions((s) => s.setFileMode);
  const moveViewToGroup = useSessions((s) => s.moveViewToGroup);
  const moveGroupToGroup = useSessions((s) => s.moveGroupToGroup);
  const resizeSplit = useSessions((s) => s.resizeSplit);

  const containerRef = useRef<HTMLDivElement>(null);
  // 드래그 중인 대상: 탭(뷰 하나) 또는 타이틀바(그룹 전체).
  const [drag, setDrag] = useState<{ kind: "view" | "group"; id: string } | null>(
    null,
  );
  const [hover, setHover] = useState<{ groupId: string; zone: DropZone } | null>(
    null,
  );

  const { cells, dividers } = useMemo(
    () => computeLayout(project.layout),
    [project.layout],
  );

  // 본문 슬롯(viewId 키, 영속). 그룹의 rect 에서 탭바 높이만큼 내려 배치.
  const bodySlots: { view: View; group: ViewGroup; rect: Rect }[] = cells.flatMap(
    ({ group, rect }) => group.views.map((view) => ({ view, group, rect })),
  );

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
      resizeSplit(project.id, d.splitId, sizes);
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

  const endDrag = () => {
    setDrag(null);
    setHover(null);
  };

  return (
    <div className="egroup-area" ref={containerRef}>
      {/* ── 영속 본문 레이어: viewId 키 → 이동해도 remount 없음 ── */}
      {bodySlots.map(({ view, group, rect }) => {
        const isActiveView = view.id === group.activeViewId;
        return (
          <div
            key={view.id}
            className="egroup-body-slot"
            style={{
              left: `${rect.left}%`,
              top: `calc(${rect.top}% + ${TAB_BAR_PX}px)`,
              width: `${rect.width}%`,
              height: `calc(${rect.height}% - ${TAB_BAR_PX}px)`,
              visibility: isActiveView ? "visible" : "hidden",
              zIndex: isActiveView ? 1 : 0,
            }}
            onMouseDownCapture={() => setActiveGroup(project.id, group.id)}
          >
            {view.kind === "terminal" ? (
              <PaneTree
                node={view.layout}
                projectId={project.id}
                viewId={view.id}
                active={isActiveProject && isActiveView}
                focusedPaneId={view.focusedPaneId}
              />
            ) : (
              <FileViewer
                path={view.path}
                mode={view.mode}
                isDark={isDark}
                projectId={project.id}
                viewId={view.id}
                onMode={(m) => setFileMode(project.id, view.id, m)}
              />
            )}
          </div>
        );
      })}

      {/* ── 그룹 chrome 레이어: 탭 바(셀 상단 스트립) ── */}
      {cells.map(({ group, rect }) => {
        const isActiveGroup = group.id === project.activeGroupId;
        return (
          <div
            key={`tabs-${group.id}`}
            className={`egroup-tabs${isActiveGroup ? " active" : ""}`}
            style={{
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: TAB_BAR_PX,
            }}
          >
            <ViewTabs
              projectId={project.id}
              group={group}
              onViewDragStart={(viewId) => setDrag({ kind: "view", id: viewId })}
              onGroupDragStart={(groupId) =>
                setDrag({ kind: "group", id: groupId })
              }
              onDragEnd={endDrag}
            />
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

      {/* ── 드롭 오버레이 레이어: 드래그 중에만(평소엔 본문이 포인터 받음) ── */}
      {drag &&
        cells.map(({ group, rect }) => (
          <div
            key={`drop-${group.id}`}
            className="drop-target"
            style={{
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHover({
                groupId: group.id,
                zone: zoneFromEvent(e, e.currentTarget),
              });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const zone = zoneFromEvent(e, e.currentTarget);
              if (drag.kind === "view") {
                moveViewToGroup(project.id, drag.id, group.id, zone);
              } else {
                moveGroupToGroup(project.id, drag.id, group.id, zone);
              }
              endDrag();
            }}
          >
            {hover && hover.groupId === group.id && (
              <div className={`drop-ind ${hover.zone}`} />
            )}
          </div>
        ))}
    </div>
  );
}
