import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { execute } from "../commands/registry";
import { ProgramMenu } from "./ProgramMenu";
import {
  viewDisplayTitle,
  type Program,
  type Pane,
} from "../state/sessions";
import { useAddTabIntent } from "../state/addTabIntent";
import { useCloseConfirm } from "../state/closeConfirm";
import { getRegisteredView, useViewRegistry } from "../plugins/viewRegistry";
import { useProgramRegistry } from "../plugins/programRegistry";
import { Icon } from "../ui/icons/Icon";
import { tabIconOf } from "../lib/tabIcon";
import type { Tab } from "../state/sessions";
import { useT } from "../i18n";

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

/** Draws what tabIconOf decided, and `tab.list` reads that same function — a second copy would agree
 *  with itself while disagreeing with the screen (E6). A reported icon that fails to load falls back
 *  to the manifest glyph; hiding the failure would make it undiagnosable and shift the alignment. */
function renderTabIcon(v: Tab): React.ReactNode {
  const decided = tabIconOf(v);
  const manifest = getRegisteredView(`${v.pluginId}.${v.view}`)?.decl.icon;
  const fallback = manifest ?? <Icon name="plugin" size="sm" />;
  if (decided.source === "reported") {
    return <TabIcon viewId={v.id} src={decided.value} fallback={fallback} />;
  }
  if (decided.source === "manifest") return decided.value;
  return <Icon name="plugin" size="sm" />;
}

// memo boundary(principle 2): onTabPointerDown must be a stable callback from GroupArea.
export const ViewTabs = memo(function ViewTabs({
  projectId,
  group,
  onTabPointerDown,
  active,
}: {
  projectId: string;
  group: Pane;
  onTabPointerDown: (viewId: string, e: React.MouseEvent) => void;
  /** Whether this is the space's active pane: the + can be pressed there and nowhere else. */
  active: boolean;
}) {
  const t = useT();
  const requestCloseView = useCloseConfirm((s) => s.requestCloseView);
  const hasPrograms = useProgramRegistry((s) => s.order.length > 0);
  // The icon comes from the view registry, which is read outside a selector in renderTabIcon. A pane
  // that rendered before its plugin registered kept the fallback glyph and nothing told it otherwise
  // — measured on the running build 2026-08-16, two panes of one view drawing two glyphs while
  // `pane.list` answered `manifest` for both. `version` is the registry's rebuild signal.
  useViewRegistry((s) => s.version);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  // The menu opens under the + button, wherever the request came from — the button itself, or the
  // shortcut, which arrives through addTabIntent because it fires at the window.
  const openAddMenu = useCallback(() => {
    const r = addBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
  }, []);
  const addRequest = useAddTabIntent((s2) => s2.request);
  const clearAddRequest = useAddTabIntent((s2) => s2.clear);
  useEffect(() => {
    if (addRequest?.paneId !== group.id) return;
    clearAddRequest();
    openAddMenu();
  }, [addRequest, group.id, clearAddRequest, openAddMenu]);

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

  // The active tab is kept at the centre of the strip. A split or a merge changes the strip's width
  // without changing which tab is active or how many there are, so the width is a reason to centre
  // on its own — measured 2026-09-04: after a split the active tab sat half outside the strip.
  const centerActive = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(".tab.active");
    if (!active) return;
    const elR = el.getBoundingClientRect();
    const aR = active.getBoundingClientRect();
    const center = aR.left - elR.left + el.scrollLeft + aR.width / 2;
    const target = center - el.clientWidth / 2;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });
    // A width change lands every frame of a divider drag. It centres without animation: a smooth
    // scroll started per frame is restarted before it finishes and the strip lags the pointer.
    const ro = new ResizeObserver(() => {
      recompute();
      centerActive("auto");
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [centerActive]);

  useLayoutEffect(() => {
    recompute();
  }, [group.tabs.length]);

  useEffect(() => {
    centerActive("smooth");
  }, [group.activeTabId, group.tabs.length, centerActive]);

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
            data-input-activate-tab={v.id}
            onMouseDown={(e) => onTabPointerDown(v.id, e)}
            // Double click = maximize(whole content area) — the header turns into a title,
            // and a double click or the button there restores it.
            onDoubleClick={() => void execute("tab.maximize", { tab: v.id }, {})}
            title={
              `${v.pluginId}.${v.view}`
            }
          >
            <span className="tab-icon icon-inline" data-tab-icon={tabIconOf(v).source}>
              {renderTabIcon(v)}
            </span>
            <span className="tab-title">{viewDisplayTitle(v)}</span>
            {v.status?.code === "dirty" && (
              <span className="tab-dirty" title={t("view.unsaved")}>
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
            title={active ? t("view.new") : undefined}
            // Pressable on the active pane only, and it changes nothing but the menu: the pane is
            // not activated, and the focus stays where it is. It used to activate the pane it was
            // on (2026-09-04), so pressing it on an idle pane moved the focus and the rail before
            // any program was chosen. On an idle pane nothing answers a hover either: no tooltip,
            // and the pointer passes through (App.css .tab-add:disabled).
            //
            // The mousedown is kept off the strip's drag machinery, and its default action is
            // refused: a button takes focus when it is clicked, and the terminal under it would
            // lose focus and read as inactive.
            disabled={!active}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => {
              if (menuPos) {
                setMenuPos(null);
                return;
              }
              openAddMenu();
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
