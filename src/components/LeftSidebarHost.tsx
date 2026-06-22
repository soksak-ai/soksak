// 좌측 사이드바 호스트 — sidebar-left 뷰 프레임. 레이아웃은 project.leftLayout(SplitTree<SidebarGroup>).
// [중복 제거] 콘텐츠 영역(GroupArea)과 *동일한* 분할 머신을 공유한다(splitLayout.ts): computeSplitLayout
// 으로 % 좌표 셀, hitTestCells 로 5존(center/left/right/top/bottom) 드롭, 같은 drop-ind/divider 시각.
// 사이드바는 폭이 좁아 col(세로) 분할이 자연스럽지만 콘텐츠와 같은 4방향 드롭을 지원한다(좌/우=row).
// keep-alive: 한 번 연 뷰는 mount 유지(display 토글).

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
import { rafThrottle } from "../lib/rafThrottle";
import {
  computeSplitLayout,
  hitTestCells,
  cellVars,
  type DropZone,
} from "./splitLayout";
import {
  useViewRegistry,
  viewsForPlacement,
  getRegisteredView,
} from "../plugins/viewRegistry";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useViewLabels, resolveViewLabel } from "../state/viewLabels";
import {
  type SidebarGroup,
  type SidebarDrop,
  reconcileSidebarLayout,
  sidebarViewKeys,
} from "../state/sidebarLayout";
import { isComposingEnter } from "../lib/imeKeys";
import { localize } from "../i18n";

const DRAG_THRESHOLD = 5;
const SIDEBAR_HEADER_PX = 30; // 탭 줄 높이(본문 가장자리 분할 판정 기준). 상태바 없음(=0).
// 콘텐츠 그룹과 동일한 pane-inset(테마별) — 사이드바 본문도 같은 여백을 줘야 콘텐츠 row2(뷰 탭)와
// 정렬된다(콘텐츠 그룹은 inset 만큼 row2 가 밀린다). GroupArea.PANE_INSET 과 동일 값.
const PANE_INSET: Record<string, number> = { flat: 0, card: 5, floating: 6 };

// 콘텐츠 zone → 사이드바 drop(콘텐츠와 동일 4방향). center=탭 합류, 좌/우=가로(row) 분할,
// 상/하=세로(col) 분할.
function zoneToDrop(targetKey: string, zone: DropZone): SidebarDrop {
  if (zone === "center") return { type: "into", targetKey };
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  return { type: "split", targetKey, dir, before };
}

export const LeftSidebarHost = memo(function LeftSidebarHost({
  project,
  paneId,
}: {
  project: ProjectTab;
  paneId: string;
}) {
  const version = useViewRegistry((s) => s.version);
  // 콘텐츠 그룹과 동일한 pane-inset(테마 paneStyle) — row2 정렬용.
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const paneInset = PANE_INSET[paneStyle] ?? 0;
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
  const setLeftTab = useSessions((s) => s.setLeftTab);

  // 등록 뷰와 reconcile.
  useEffect(() => {
    reconcileSidebar(project.id, registeredKeys);
  }, [project.id, registeredKeys, reconcileSidebar]);
  const layout = useMemo(
    () => reconcileSidebarLayout(project.leftLayout, registeredKeys),
    [project.leftLayout, registeredKeys],
  );

  // keep-alive 누적.
  const openedRef = useRef<Set<string>>(new Set());
  for (const k of sidebarViewKeys(layout)) openedRef.current.add(k);
  const opened = [...openedRef.current].filter((k) => registeredKeys.includes(k));

  // 공유 머신으로 셀/divider 계산.
  const { cells, dividers } = useMemo(() => computeSplitLayout(layout), [layout]);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  // 각 셀(leaf 그룹)의 고유 id = viewKeys join(레이아웃 내 유일).
  const cellId = (g: SidebarGroup) => g.viewKeys.join("|");

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [hover, setHover] = useState<{ cellId: string; zone: DropZone } | null>(null);

  // 포인터 → 셀/zone(공유 hitTestCells, 콘텐츠와 동일 4방향). sourceCellId = 끌고 있는 탭의 셀
  // (자기 분할 가드는 그 셀 뷰 1개일 때만 — 다중 뷰면 가장자리 드롭으로 분리 허용).
  const hitTest = useCallback(
    (x: number, y: number, r: DOMRect, sourceCellId: string, selfCenterOnly: boolean) =>
      hitTestCells(
        x,
        y,
        r,
        cellsRef.current.map((c) => ({ value: c.value, rect: c.rect })),
        cellId,
        { chromeTop: SIDEBAR_HEADER_PX, statusPx: 0, sourceId: sourceCellId, selfCenterOnly },
      ),
    [],
  );

  // 탭 드래그(뷰 이동). 임계 미만이면 클릭(탭 전환).
  const startDrag = useCallback(
    (viewKey: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const srcCell = cellsRef.current.find((c) => c.value.viewKeys.includes(viewKey));
      const srcCellId = srcCell ? cellId(srcCell.value) : "";
      const selfCenterOnly = !srcCell || srcCell.value.viewKeys.length <= 1;
      let moved = false;
      let rect: DOMRect | null = null;
      const updateHover = rafThrottle((x: number, y: number) => {
        const h = rect ? hitTest(x, y, rect, srcCellId, selfCenterOnly) : null;
        setHover((prev) =>
          prev?.cellId === h?.id && prev?.zone === h?.zone
            ? prev
            : h
              ? { cellId: h.id, zone: h.zone }
              : null,
        );
      });
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
          moved = true;
          rect = containerRef.current?.getBoundingClientRect() ?? null;
          setDrag(viewKey);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        updateHover(ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        updateHover.cancel();
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          const h = rect ? hitTest(ev.clientX, ev.clientY, rect, srcCellId, selfCenterOnly) : null;
          if (h) {
            // 대상 그룹을 "드래그한 뷰가 아닌" 멤버로 지정한다 — viewKey 는 이동 중 source 에서
            // 제거되므로, targetKey 가 viewKey 와 같으면 대상 그룹을 못 찾아 뷰가 유실된다(같은
            // 그룹 안 분할 시 발생). 다른 멤버를 우선, 없으면 활성 뷰(다른 그룹이면 viewKey 부재라 안전).
            const targetCell = cellsRef.current.find((c) => cellId(c.value) === h.id);
            const keys = targetCell?.value.viewKeys ?? [];
            const targetKey = keys.find((k) => k !== viewKey) ?? targetCell?.value.activeViewKey ?? "";
            if (targetKey && !(h.id === srcCellId && h.zone === "center")) {
              moveSidebarView(project.id, viewKey, zoneToDrop(targetKey, h.zone));
            }
          }
        } else {
          setLeftTab(project.id, viewKey); // 클릭 = 탭 전환
        }
        setDrag(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [project.id, hitTest, moveSidebarView, setLeftTab],
  );

  // divider 드래그(분할 비율). 콘텐츠 onDividerDown 과 동일 로직.
  const onDividerDown = (d: (typeof dividers)[number]) => (e: React.MouseEvent) => {
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    const cr = cont.getBoundingClientRect();
    const totalPx = d.dir === "row" ? cr.width : cr.height;
    const splitPx = (totalPx * d.spanPct) / 100;
    if (splitPx <= 0) return;
    const startPos = d.dir === "row" ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const i = d.index;
    const minFrac = 0.1;
    const commit = rafThrottle((sizes: number[]) =>
      resizeSidebar(project.id, d.splitId, sizes),
    );
    const onMove = (ev: MouseEvent) => {
      const cur = d.dir === "row" ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / splitPx;
      delta = Math.max(-(startSizes[i] - minFrac), Math.min(startSizes[i + 1] - minFrac, delta));
      const sizes = [...startSizes];
      sizes[i] = startSizes[i] + delta;
      sizes[i + 1] = startSizes[i + 1] - delta;
      commit(sizes);
    };
    const onUp = () => {
      commit.flush();
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

  const hoverCell = hover && cells.find((c) => cellId(c.value) === hover.cellId);

  return (
    <div className="left-host">
      {/* 셀이 % 절대 배치되는 그리드(콘텐츠 egroup-area 와 동일 모델) — footer 는 그 아래 흐름 밖. */}
      <div
        className="left-host-grid"
        ref={containerRef}
        style={
          // --drop-top-h:0 → 드롭 플레이스홀더(.drop-ind-wrap)가 셀 전체(탭 줄 포함)를 덮는다.
          // --header-h 는 건드리지 않는다(플러그인 row2 밴드 높이 = 콘텐츠 뷰탭 밴드와 동일 33px 상속).
          // (히트테스트의 헤더 오프셋은 JS SIDEBAR_HEADER_PX 가 따로 소유 — 시각/판정 분리.)
          { "--drop-top-h": "0px", "--status-h": "0px", "--pane-inset": `${paneInset}px` } as CSSProperties
        }
      >
        {/* 셀(leaf 그룹) — 콘텐츠 egroup 처럼 % 절대 위치. 내부 = [탭 줄][본문]. */}
        {cells.map(({ value: group, rect }, i) => (
          <div
            key={cellId(group)}
            className="left-host-cell"
            // 셀 드롭 타겟(E2E/AI): ui.input.drag 의 to 로 셀(인덱스)을 가리키고 zone 으로 분할/합류.
            data-node={`cell/${i}`}
            style={cellVars(rect) as CSSProperties}
          >
            <SidebarLeaf
              group={group}
              project={project}
              paneId={paneId}
              opened={opened}
              dragging={drag}
              startDrag={startDrag}
            />
          </div>
        ))}

        {/* 분할 경계(divider) — 콘텐츠와 동일 클래스/시각. */}
        {dividers.map((d) => (
          <div
            key={`div-${d.splitId}-${d.index}`}
            className={`egroup-divider ${d.dir}`}
            style={
              d.dir === "row"
                ? { left: `${d.rect.left}%`, top: `${d.rect.top}%`, height: `${d.rect.height}%` }
                : { left: `${d.rect.left}%`, top: `${d.rect.top}%`, width: `${d.rect.width}%` }
            }
            onMouseDown={onDividerDown(d)}
          />
        ))}

        {/* 드롭 인디케이터 — 콘텐츠와 동일(drop-ind-wrap + drop-ind.zone). */}
        {drag && hover && hoverCell && (
          <div className="drop-ind-wrap" style={cellVars(hoverCell.rect) as CSSProperties}>
            <div className={`drop-ind ${hover.zone}`} />
          </div>
        )}
      </div>

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

// 한 leaf = 탭 줄(그 그룹의 뷰들) + 활성 뷰 본문. keep-alive: opened 뷰 mount, display 토글.
function SidebarLeaf({
  group,
  project,
  paneId,
  opened,
  dragging,
  startDrag,
}: {
  group: SidebarGroup;
  project: ProjectTab;
  paneId: string;
  opened: string[];
  dragging: string | null;
  startDrag: (viewKey: string) => (e: React.MouseEvent) => void;
}) {
  const setLabel = useViewLabels((s) => s.setLabel);
  const labelVersion = useViewLabels((s) => s.labels);
  void labelVersion;
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const active = group.activeViewKey;
  const hosted = opened.filter((k) => group.viewKeys.includes(k));

  return (
    <div className="left-host-leaf">
      <div className="left-host-tabs">
        {group.viewKeys.map((key) => {
          const reg = getRegisteredView(key);
          const fallback = reg ? localize(reg.decl.title) : key;
          const label = resolveViewLabel(key, fallback);
          const editing = editingKey === key;
          // 콘텐츠 탭(.ctab, 상단 탭 줄)과 *동일 구조/디자인* 재사용 — 편집 박스는 .ctab.editing 이,
          // 입력은 .ctab-rename(투명·font:inherit)이 소유한다(라벨과 폰트/모양 동일). left-host-tab 은 드래그 마커만.
          return (
            <div
              key={key}
              className={`ctab left-host-tab${active === key ? " active" : ""}${editing ? " editing" : ""}${dragging === key ? " dragging" : ""}`}
              data-node={`tab/left/${key}`}
              title={label}
              onMouseDown={editing ? undefined : startDrag(key)}
              onDoubleClick={() => setEditingKey(key)}
            >
              {editing ? (
                <input
                  className="ctab-rename"
                  data-node={`tab/left/${key}/rename`}
                  defaultValue={label}
                  autoFocus
                  onMouseDown={(e) => e.stopPropagation()}
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
              ) : (
                <>
                  <span className="ctab-title">{label}</span>
                  <ViewBadge viewKey={key} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="left-host-body-wrap" data-node="bodywrap">
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
