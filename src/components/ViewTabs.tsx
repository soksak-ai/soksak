import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useT } from "../i18n";

// 콘텐츠 영역 상단의 뷰 탭 줄(터미널/파일 전환) + 커스텀 가로 스크롤바.
//
// WKWebView(macOS)의 네이티브 오버레이 스크롤바는 ::-webkit-scrollbar 로 두께/색을
// 바꿀 수 없다(굵은 흰 막대 그대로). 그래서 네이티브는 숨기고(전역 CSS), 여기서 3px
// 커스텀 썸을 직접 그려 위치를 동기화하고 드래그도 처리한다 — 배경색에 동화되는 옅은 회색.

export function ViewTabs({ project }: { project: ProjectTab }) {
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
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    if (scrollWidth <= clientWidth + 1) {
      setThumb(null); // 넘치지 않으면 스크롤바 없음
      return;
    }
    const width = (clientWidth / scrollWidth) * clientWidth;
    const left = (scrollLeft / scrollWidth) * clientWidth;
    setThumb({ left, width });
  };

  // 스크롤/리사이즈에 동기화.
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

  // 탭 개수가 바뀌면(scrollWidth 변화) 재계산 — ResizeObserver 는 콘텐츠 변화로는 안 뜬다.
  useLayoutEffect(() => {
    recompute();
  }, [project.views.length]);

  // 썸 드래그 → scrollLeft 매핑.
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
