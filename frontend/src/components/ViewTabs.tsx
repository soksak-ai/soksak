import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { execute } from "../commands/registry";
import { ProgramMenu } from "./ProgramMenu";
import {
  viewDisplayTitle,
  type Program,
  type Pane,
} from "../state/sessions";
import { useCloseConfirm } from "../state/closeConfirm";
import { getRegisteredView } from "../plugins/viewRegistry";
import { useProgramRegistry } from "../plugins/programRegistry";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";

// Plugin view tab icon: the manifest-declared icon(string — external contract).
// null when the provider is unregistered(inactive) — the caller falls back to the standard plugin icon.
function pluginIconOf(pluginId: string, view: string): string | null {
  return getRegisteredView(`${pluginId}.${view}`)?.decl.icon ?? null;
}

// Tab icon — draws the icon a view reported (v.icon), falling back to the manifest icon on load
// failure. Hiding the failure(blank) makes it undiagnosable and shifts tab alignment. A changed src
// resets the failure state. Any view reports one; a page's own icon is one caller of this, not what
// it is for (C6).
function TabIcon({ viewId, src, fallback }: { viewId: string; src: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <>{fallback}</>;
  return (
    <img
      data-node={`tab/view/${viewId}/icon`}
      src={src}
      style={{ width: 14, height: 14, borderRadius: 3, objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

// Tab bar of one editor group(terminal/file switching + view drag source). Drag starts from the pointer
// (mousedown), not HTML5 DnD(avoids conflict with Tauri native file drag-drop + actually works).
// Tab click(released without movement)=switch, drag=move that view — GroupArea makes that determination.
// Horizontal overflow hides the native overlay scrollbar and draws a 3px custom thumb.

// memo boundary(principle 2): onTabPointerDown must be a stable callback from GroupArea.
export const ViewTabs = memo(function ViewTabs({
  projectId,
  group,
  onTabPointerDown,
}: {
  projectId: string;
  group: Pane;
  onTabPointerDown: (viewId: string, e: React.MouseEvent) => void;
}) {
  const t = useT();
  const requestCloseView = useCloseConfirm((s) => s.requestCloseView);
  const hasPrograms = useProgramRegistry((s) => s.order.length > 0);
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
  }, [group.tabs.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(".tab.active");
    if (!active) return;
    const elR = el.getBoundingClientRect();
    const aR = active.getBoundingClientRect();
    const center = aR.left - elR.left + el.scrollLeft + aR.width / 2;
    const target = center - el.clientWidth / 2;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior: "smooth" });
  }, [group.activeTabId, group.tabs.length]);

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
    <div className="tabs-wrap">
      <div className="tabs" ref={scrollRef}>
        {group.tabs.map((v) => (
          <div
            key={v.id}
            className={`tab${v.id === group.activeTabId ? " active" : ""}`}
            data-node={`tab/view/${v.id}`}
            onMouseDown={(e) => onTabPointerDown(v.id, e)}
            // Double click = maximize(whole content area) — the header turns into a title,
            // and a double click or the button there restores it.
            onDoubleClick={() => void execute("tab.maximize", { tab: v.id }, {})}
            title={
              v.kind === "file" ? v.path : `${v.pluginId}.${v.view}`
            }
          >
            <span className="tab-icon icon-inline">
              {v.kind === "file" ? (
                <Icon name="file" size="sm" />
              ) : v.icon ? (
                // Content fact icon — a setIcon report takes precedence over the manifest icon.
                <TabIcon
                  viewId={v.id}
                  src={v.icon}
                  fallback={pluginIconOf(v.pluginId, v.view) ?? <Icon name="plugin" size="sm" />}
                />
              ) : (
                // The plugin icon is the manifest-declared string(external contract) — fallback only when unregistered.
                (pluginIconOf(v.pluginId, v.view) ?? (
                  <Icon name="plugin" size="sm" />
                ))
              )}
            </span>
            <span className="tab-title">{viewDisplayTitle(v)}</span>
            {v.kind === "file" && v.status?.code === "dirty" && (
              <span className="tab-dirty" title={t("viewer.unsaved")}>
                <Icon name="dirty" size="xs" />
              </span>
            )}
            <button
              type="button"
              className="icon-btn icon-btn--mini tab-close"
              data-node={`tab/view/${v.id}/close`}
              title={t("view.close")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseView(projectId, v.id);
              }}
            >
              <Icon name="close" size="md" />
            </button>
          </div>
        ))}
        {/* With zero registered programs there is no + button at all (no built-ins, §2.6) */}
        {hasPrograms && (
          <button
            ref={addBtnRef}
            type="button"
            className="icon-btn tab-add"
            data-node={`tab/view/${group.id}/add`}
            title={t("view.new")}
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
            <Icon name="add" />
          </button>
        )}
      </div>
      {menuPos && (
        <ProgramMenu
          pos={menuPos}
          onPick={async (program: Program) => {
            try {
              await execute("tab.open", { pane: group.id, program }, {});
            } finally {
              // ProgramMenu owns the native overlay lease. Unmounting it before tab.open is
              // terminal exposes an existing child webview under the same AppKit mouse release
              // that selected this item, allowing native activation to re-enter the unfinished
              // DOM transaction. Release the lease only at the command's terminal boundary.
              setMenuPos(null);
            }
          }}
          onClose={() => setMenuPos(null)}
        />
      )}
      {thumb && (
        <div className="tabs-scrollbar">
          <div
            className="tabs-scrollbar-thumb"
            style={{ left: thumb.left, width: thumb.width }}
            onMouseDown={onThumbDown}
          />
        </div>
      )}
    </div>
  );
});
