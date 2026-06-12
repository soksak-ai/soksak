import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ProgramMenu } from "./ProgramMenu";
import {
  useSessions,
  type Program,
  type ViewGroup,
} from "../state/sessions";
import { getRegisteredView } from "../plugins/viewRegistry";
import { useT } from "../i18n";

// 플러그인 뷰 탭 아이콘: 매니페스트 선언 아이콘, provider 미등록(비활성)이면 폴백.
function pluginIconOf(pluginId: string, view: string): string {
  return getRegisteredView(`${pluginId}.${view}`)?.decl.icon ?? "▦";
}

// 한 에디터 그룹의 탭 바(터미널/파일 전환 + 뷰 드래그 소스). 드래그는 HTML5 DnD 가 아니라
// 포인터(mousedown)로 시작한다(Tauri 네이티브 파일 drag-drop 과 충돌 회피 + 실제 동작).
// 탭 클릭(이동 없이 떼면)=전환, 끌면=그 뷰 이동 — 판정은 GroupArea 가 한다.
// 가로 오버플로는 네이티브 오버레이 스크롤바를 숨기고 3px 커스텀 썸을 그린다.

export function ViewTabs({
  projectId,
  group,
  onTabPointerDown,
}: {
  projectId: string;
  group: ViewGroup;
  onTabPointerDown: (viewId: string, e: React.MouseEvent) => void;
}) {
  const t = useT();
  const closeView = useSessions((s) => s.closeView);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );

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
    e.stopPropagation();
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
            onMouseDown={(e) => onTabPointerDown(v.id, e)}
            title={
              v.kind === "file"
                ? v.path
                : v.kind === "browser"
                  ? v.url
                  : v.kind === "plugin"
                    ? `${v.pluginId}.${v.view}`
                    : t("view.terminal")
            }
          >
            <span className="view-tab-icon">
              {v.kind === "terminal"
                ? "›_"
                : v.kind === "file"
                  ? "▤"
                  : v.kind === "plugin"
                    ? pluginIconOf(v.pluginId, v.view)
                    : "◍"}
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
              onMouseDown={(e) => e.stopPropagation()}
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
          ref={addBtnRef}
          type="button"
          className="view-add"
          title={t("content.new")}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            if (menuPos) {
              setMenuPos(null);
              return;
            }
            const r = addBtnRef.current?.getBoundingClientRect();
            if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
          }}
        >
          +
        </button>
      </div>
      {menuPos && (
        <ProgramMenu
          pos={menuPos}
          onPick={(program: Program) => {
            addViewToGroup(projectId, program, group.id);
            setMenuPos(null);
          }}
          onClose={() => setMenuPos(null)}
        />
      )}
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
