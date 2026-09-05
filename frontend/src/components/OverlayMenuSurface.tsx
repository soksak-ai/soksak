// Declares the overlay menu's native webview surface when a menu is open.
//
// A native surface is composited above the document, so this surface is drawn above every terminal.
// Its page is the menu; it is placed at the menu's box, not parked over anything. Opening it adds a
// native layer and closing it removes one — the terminals under it are never taken off the screen,
// so there is no picture swap and no flicker (the defect measured 2026-09-05).
//
// The element holds the surface declaration the compositor reads (data-native-surface…), the same
// vocabulary a terminal or a browser pane declares in. Its source is the whole menu as a data: URL,
// so a new menu is a new source and the compositor rebuilds the surface for it.
import { useEffect, useMemo } from "react";
import { useOverlayMenu, OVERLAY_MENU_LABEL } from "../state/overlayMenu";
import { overlayMenuDataUrl, type OverlayMenuColors } from "../lib/overlayMenuPage";

// Above every content surface. Terminals and browser panes declare layer 0; the menu is above all
// of them.
const OVERLAY_MENU_LAYER = 1000;

function menuColors(): OverlayMenuColors {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  // The tokens the document's own menu reads (.space-tab-menu): --bg, --fg, --bd. Hover and muted
  // have no token, so they are theme-agnostic translucent greys that read on either ground.
  return {
    bg: pick("--bg", "#1e1e1e"),
    fg: pick("--fg", "#e6e6e6"),
    hover: "rgba(127,127,127,0.16)",
    border: pick("--bd", "rgba(127,127,127,0.35)"),
    muted: "rgba(140,140,140,0.9)",
  };
}

export function OverlayMenuSurface() {
  const open = useOverlayMenu((s) => s.open);
  const items = useOverlayMenu((s) => s.items);
  const box = useOverlayMenu((s) => s.box);
  const generation = useOverlayMenu((s) => s.generation);

  // The whole menu as a source, rebuilt only when the items or the generation change — not every
  // render. The colours are read when the source is built, so the menu matches the current theme.
  const source = useMemo(
    () => (open ? JSON.stringify({ url: overlayMenuDataUrl(items, menuColors()) }) : ""),
    [open, items, generation],
  );

  // A press on the document — the chrome, a tab bar — dismisses the menu. A press on a terminal or on
  // the menu itself never goes to the document (a surface takes its own clicks); those are handled by
  // content-view-activated and the menu's own page. The listener attaches after the opening click,
  // so that click does not close what it just opened.
  useEffect(() => {
    if (!open) return;
    const close = (e?: Event) => {
      // A press on the + that opened the menu is left to the +'s own click, which toggles the menu
      // shut. Closing here too would make that click reopen it (pointerdown closes, click reopens).
      if (e && (e.target as Element | null)?.closest?.(".tab-add")) return;
      useOverlayMenu.getState().close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!open || !box) return null;
  return (
    <div
      data-native-surface="webview"
      data-native-surface-id={OVERLAY_MENU_LABEL}
      data-native-generation={String(generation)}
      data-native-source={source}
      data-native-visible="true"
      data-native-alpha="1"
      data-native-layer={String(OVERLAY_MENU_LAYER)}
      data-surface-visible="true"
      style={{
        position: "fixed",
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        zIndex: 40,
        // Rounded to match a menu; the native webview fills this box. The border is drawn by the
        // page, not here — this element is only the slot the surface is placed in.
        pointerEvents: "none",
      }}
    />
  );
}
