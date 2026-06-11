import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useT } from "../i18n";

// 콘텐츠 영역 뷰 탭(터미널/파일 전환). 상단(가로) 또는 좌측(세로) 모드.
// 가로 모드는 네이티브 오버레이 스크롤바를 숨기고 3px 커스텀 썸을 그린다(WKWebView 가
// 두께/색을 못 바꾸므로). 세로 모드는 전역 얇은 스크롤바 사용.

export function ViewTabs({
  project,
  vertical = false,
}: {
  project: ProjectTab;
  vertical?: boolean;
}) {
  const t = useT();
  const setActiveView = useSessions((s) => s.setActiveView);
  const closeView = useSessions((s) => s.closeView);
  const addTerminalView = useSessions((s) => s.addTerminalView);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
    null,
  );

  // 가로 커스텀 스크롤바 썸 위치 계산(세로 모드면 사용 안 함).
  const recompute = () => {
    const el = scrollRef.current;
    if (!el || vertical) {
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
    if (!el || vertical) return;
    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertical]);

  useLayoutEffect(() => {
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.views.length, vertical]);

  // 활성 탭을 보이도록 자동 스크롤(가능하면 중앙, 끝이면 클램프). 양 방향.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(".view-tab.active");
    if (!active) return;
    const elR = el.getBoundingClientRect();
    const aR = active.getBoundingClientRect();
    if (vertical) {
      const center = aR.top - elR.top + el.scrollTop + aR.height / 2;
      const target = center - el.clientHeight / 2;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTo({ top: Math.max(0, Math.min(max, target)), behavior: "smooth" });
    } else {
      const center = aR.left - elR.left + el.scrollLeft + aR.width / 2;
      const target = center - el.clientWidth / 2;
      const max = el.scrollWidth - el.clientWidth;
      el.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior: "smooth" });
    }
  }, [project.activeViewId, project.views.length, vertical]);

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

  const tabEls = (
    <>
      {project.views.map((v) => (
        <div
          key={v.id}
          className={`view-tab${v.id === project.activeViewId ? " active" : ""}`}
          onClick={() => setActiveView(project.id, v.id)}
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
          {project.views.length > 1 && (
            <button
              type="button"
              className="view-tab-close"
              title={t("view.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeView(project.id, v.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="view-add"
        title={t("view.newTerminal")}
        onClick={() => addTerminalView(project.id)}
      >
        +
      </button>
    </>
  );

  if (vertical) {
    return (
      <div className="view-tabs vertical" ref={scrollRef}>
        {tabEls}
      </div>
    );
  }

  return (
    <div className="view-tabs-wrap">
      <div className="view-tabs" ref={scrollRef}>
        {tabEls}
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
