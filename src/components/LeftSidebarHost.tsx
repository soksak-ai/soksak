// 좌측 사이드바 호스트 — sidebar-left 뷰의 프레임(계약 docs/SIDEBAR.md). 레이아웃은 project.leftLayout
// (SplitTree<SidebarGroup>, B2) — 콘텐츠 영역과 동일한 drag-merge: 탭을 끌어 다른 leaf 에 합치거나
// (into) 위/아래 가장자리에 떨어뜨려 세로 분할(split). 등록 뷰와 reconcile(추가/제거).
// 코어는 프레임만(콘텐츠 0). keep-alive: 한 번 연 뷰는 mount 유지(display 토글).

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { PluginViewHost } from "./PluginViewHost";
import { ViewBadge } from "./ViewBadge";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useViewRegistry, viewsForPlacement, getRegisteredView } from "../plugins/viewRegistry";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useViewLabels, resolveViewLabel } from "../state/viewLabels";
import {
  type SidebarLayout,
  type SidebarGroup,
  type SidebarDrop,
  reconcileSidebarLayout,
  sidebarViewKeys,
} from "../state/sidebarLayout";
import type { SplitTree } from "../state/splitTree";
import { isComposingEnter } from "../lib/imeKeys";
import { localize } from "../i18n";

const DRAG_THRESHOLD = 4;

// 드롭 판정 결과(호버 표시 + 드롭 실행). zone: into=탭 합류, top/bottom=세로 분할.
type Hover = { targetKey: string; zone: "into" | "top" | "bottom" };

interface DragCtl {
  dragging: string | null;
  hover: Hover | null;
  startDrag: (viewKey: string) => (e: React.MouseEvent) => void;
}

export const LeftSidebarHost = memo(function LeftSidebarHost({
  project,
  paneId,
}: {
  project: ProjectTab;
  paneId: string;
}) {
  const version = useViewRegistry((s) => s.version);
  const registeredKeys = useMemo(
    () => viewsForPlacement("sidebar-left").map((v) => v.key),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const footerViews = useMemo(
    () => viewsForPlacement("sidebar-footer"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const reconcileSidebar = useSessions((s) => s.reconcileSidebar);
  const moveSidebarView = useSessions((s) => s.moveSidebarView);
  const resizeSidebar = useSessions((s) => s.resizeSidebar);

  // 등록 뷰와 reconcile(렌더 시) — 새 뷰 추가/사라진 뷰 제거. set 은 변화 시에만(스토어가 참조 보존).
  useEffect(() => {
    reconcileSidebar(project.id, registeredKeys);
  }, [project.id, registeredKeys, reconcileSidebar]);

  // 렌더는 reconcile 된 형태로(스토어 반영 전이라도 즉시 정합) — 깜빡임/댕글링 방지.
  const layout = useMemo(
    () => reconcileSidebarLayout(project.leftLayout, registeredKeys),
    [project.leftLayout, registeredKeys],
  );

  // keep-alive: 이 프로젝트에서 연 뷰 누적(등록된 것만 유지).
  const openedRef = useRef<Set<string>>(new Set());
  for (const k of sidebarViewKeys(layout)) openedRef.current.add(k);
  const opened = [...openedRef.current].filter((k) => registeredKeys.includes(k));

  // ── drag-merge 컨트롤러 ──────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // 포인터 → 어느 leaf 의 어느 zone. leaf body 의 [data-leaf-key] rect 로 hit-test.
  const hitTest = useCallback((x: number, y: number): Hover | null => {
    const root = containerRef.current;
    if (!root) return null;
    const bodies = root.querySelectorAll<HTMLElement>("[data-leaf-key]");
    for (const b of bodies) {
      const r = b.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const targetKey = b.dataset.leafKey ?? "";
      const py = (y - r.top) / r.height;
      if (py < 0.28) return { targetKey, zone: "top" };
      if (py > 0.72) return { targetKey, zone: "bottom" };
      return { targetKey, zone: "into" };
    }
    return null;
  }, []);

  const startDrag = useCallback(
    (viewKey: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
          moved = true;
          setDragging(viewKey);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        const h = hitTest(ev.clientX, ev.clientY);
        setHover((prev) =>
          prev?.targetKey === h?.targetKey && prev?.zone === h?.zone ? prev : h,
        );
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          const h = hitTest(ev.clientX, ev.clientY);
          if (h && h.targetKey !== viewKey) {
            const drop: SidebarDrop =
              h.zone === "into"
                ? { type: "into", targetKey: h.targetKey }
                : { type: "split", targetKey: h.targetKey, before: h.zone === "top" };
            moveSidebarView(project.id, viewKey, drop);
          }
        } else {
          // 이동 없이 떼면 = 탭 전환은 onClick 이 처리(여기선 아무것도).
        }
        setDragging(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [project.id, hitTest, moveSidebarView],
  );

  const ctl: DragCtl = { dragging, hover, startDrag };

  return (
    <div className="left-host" ref={containerRef}>
      <SidebarNode
        node={layout}
        project={project}
        paneId={paneId}
        opened={opened}
        ctl={ctl}
        onResize={(splitId, sizes) => resizeSidebar(project.id, splitId, sizes)}
      />
      {footerViews.length > 0 && (
        <div className="left-host-footer">
          <PluginViewHost
            viewKey={footerViews[0].key}
            projectId={project.id}
            root={project.root}
            region="left"
            paneId={paneId}
          />
        </div>
      )}
    </div>
  );
});

// SplitTree 재귀 렌더 — split=세로 Group(resizable), leaf=탭 스트립 + 본문.
function SidebarNode({
  node,
  project,
  paneId,
  opened,
  ctl,
  onResize,
}: {
  node: SidebarLayout;
  project: ProjectTab;
  paneId: string;
  opened: string[];
  ctl: DragCtl;
  onResize: (splitId: string, sizes: number[]) => void;
}) {
  if (node.type === "leaf") {
    return (
      <SidebarLeaf
        group={node.value}
        project={project}
        paneId={paneId}
        opened={opened}
        ctl={ctl}
      />
    );
  }
  const childId = (c: SplitTree<SidebarGroup>): string =>
    c.type === "leaf" ? `g:${c.value.viewKeys.join("-")}` : c.id;
  return (
    <Group
      orientation="vertical"
      className="left-host-split"
      defaultLayout={Object.fromEntries(
        node.children.map((c, i) => [childId(c), node.sizes[i]]),
      )}
      onLayoutChanged={(l) => {
        const raw = node.children.map((c) => l[childId(c)] ?? 0);
        const total = raw.reduce((a, b) => a + b, 0) || 1;
        onResize(node.id, raw.map((x) => x / total));
      }}
    >
      {node.children.map((child, i) => (
        <span key={childId(child)} style={{ display: "contents" }}>
          {i > 0 && <Separator className="left-host-split-handle" />}
          <Panel id={childId(child)} minSize="12%" className="left-host-panel">
            <SidebarNode
              node={child}
              project={project}
              paneId={paneId}
              opened={opened}
              ctl={ctl}
              onResize={onResize}
            />
          </Panel>
        </span>
      ))}
    </Group>
  );
}

// 한 leaf = 탭 스트립(그 그룹의 뷰들) + 활성 뷰 본문. keep-alive: opened 뷰는 mount, display 토글.
function SidebarLeaf({
  group,
  project,
  paneId,
  opened,
  ctl,
}: {
  group: SidebarGroup;
  project: ProjectTab;
  paneId: string;
  opened: string[];
  ctl: DragCtl;
}) {
  const setLeftTab = useSessions((s) => s.setLeftTab);
  const setLabel = useViewLabels((s) => s.setLabel);
  const labelVersion = useViewLabels((s) => s.labels);
  void labelVersion;
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const active = group.activeViewKey;
  // 이 leaf 가 호스팅할 keep-alive 뷰 = opened ∩ 이 그룹의 viewKeys.
  const hosted = opened.filter((k) => group.viewKeys.includes(k));

  const hoverHere = ctl.hover && group.viewKeys.includes(ctl.hover.targetKey);
  const bodyDrop: CSSProperties =
    hoverHere && ctl.hover?.zone === "into"
      ? { boxShadow: "inset 0 0 0 2px var(--acc)" }
      : {};

  return (
    <div className="left-host-leaf">
      <div className="left-host-tabs">
        {group.viewKeys.map((key) => {
          const reg = getRegisteredView(key);
          const fallback = reg ? localize(reg.decl.title) : key;
          const label = resolveViewLabel(key, fallback);
          if (editingKey === key) {
            return (
              <input
                key={key}
                className="left-host-tab-rename"
                data-node={`tab/left/${key}/rename`}
                defaultValue={label}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setLabel(key, e.target.value === fallback ? "" : e.target.value);
                  setEditingKey(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (isComposingEnter(e)) return;
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value;
                    setLabel(key, v === fallback ? "" : v);
                    setEditingKey(null);
                  } else if (e.key === "Escape") setEditingKey(null);
                }}
              />
            );
          }
          return (
            <button
              key={key}
              type="button"
              className={`left-host-tab${active === key ? " active" : ""}${ctl.dragging === key ? " dragging" : ""}`}
              data-node={`tab/left/${key}`}
              title={label}
              onMouseDown={ctl.startDrag(key)}
              onClick={() => setLeftTab(project.id, key)}
              onDoubleClick={() => setEditingKey(key)}
            >
              {reg?.decl.icon} {label}
              <ViewBadge viewKey={key} />
            </button>
          );
        })}
      </div>
      <div className="left-host-body-wrap" data-leaf-key={active} style={bodyDrop}>
        {/* 분할 드롭 인디케이터(top/bottom) */}
        {hoverHere && ctl.hover?.zone === "top" && (
          <div className="left-host-drop-line top" />
        )}
        {hoverHere && ctl.hover?.zone === "bottom" && (
          <div className="left-host-drop-line bottom" />
        )}
        {hosted.map((k) => (
          <div
            key={k}
            className="left-host-body"
            style={{ display: active === k ? "flex" : "none" }}
          >
            <PluginViewHost
              viewKey={k}
              projectId={project.id}
              root={project.root}
              region="left"
              paneId={paneId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
