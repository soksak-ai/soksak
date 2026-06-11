import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessions, type ViewGroup } from "../state/sessions";
import { useT } from "../i18n";

// 한 에디터 그룹의 탭 바(터미널/파일 전환 + 드래그 분할 소스). 가로 모드 전용.
// 네이티브 오버레이 스크롤바를 숨기고 3px 커스텀 썸을 그린다(WKWebView 가 두께/색을
// 못 바꾸므로). 탭은 draggable — 다른 그룹의 가장자리/중앙에 드롭하면 분할/이동.

export function ViewTabs({
  projectId,
  group,
  onTabDragStart,
  onTabDragEnd,
}: {
  projectId: string;
  group: ViewGroup;
  onTabDragStart: (viewId: string) => void;
  onTabDragEnd: () => void;
}) {
  const t = useT();
  const setActiveView = useSessions((s) => s.setActiveView);
  const closeView = useSessions((s) => s.closeView);
  const addTerminalView = useSessions((s) => s.addTerminalView);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
    null,
  );

  const recompute = () => {
    const el = scrollRef.current;
    if (!el) {
      setThumb(null);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    if (scrollWidth <= clientWidth + 1) {
      setThumb(null);
      return;
    }
    const width = (clientWidth / scrollWidth) * clientWidth;
    const left = (scrollLeft / scrollWidth) * clientWidth;
    setThumb({ left, width });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    recompute();
  }, [group.views.length]);

  // 활성 탭을 보이도록 자동 스크롤(가능하면 중앙).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(".view-tab.active");
    if (!active) return;
    const elR = el.getBoundingClientRect();
    const aR = active.getBoundingClientRect();
    const center = aR.left - elR.left + el.scrollLeft + aR.width / 2;
    const target = center - el.clientWidth / 2;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior: "smooth" });
  }, [group.activeViewId, group.views.length]);

  const onThumbDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startScroll = el.scrollLeft;
    const ratio = el.scrollWidth / el.clientWidth;
    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = startScroll + (ev.clientX - startX) * ratio;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  };

  return (
    <div className="view-tabs-wrap">
      <div className="view-tabs" ref={scrollRef}>
        {group.views.map((v) => (
          <div
            key={v.id}
            className={`view-tab${v.id === group.activeViewId ? " active" : ""}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-view-id", v.id);
              onTabDragStart(v.id);
            }}
            onDragEnd={onTabDragEnd}
            onClick={() => setActiveView(projectId, v.id)}
            title={v.kind === "file" ? v.path : t("view.terminal")}
          >
            <span className="view-tab-icon">
              {v.kind === "terminal" ? "›_" : "▤"}
            </span>
            <span className="view-tab-title">
              {v.kind === "terminal" ? t("view.terminal") : v.title}
            </span>
            {v.kind === "file" && v.dirty && (
              <span className="view-tab-dirty" title={t("viewer.unsaved")}>
                ●
              </span>
            )}
            <button
              type="button"
              className="view-tab-close"
              title={t("view.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeView(projectId, v.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="view-add"
          title={t("view.newTerminal")}
          onClick={() => addTerminalView(projectId, group.id)}
        >
          +
        </button>
      </div>
      {thumb && (
        <div className="view-scrollbar">
          <div
            className="view-scrollbar-thumb"
            style={{ left: thumb.left, width: thumb.width }}
            onMouseDown={onThumbDown}
          />
        </div>
      )}
    </div>
  );
}
