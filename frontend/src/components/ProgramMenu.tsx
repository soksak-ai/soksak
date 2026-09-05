import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Program } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { programPathSegments } from "../plugins/spec";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { localize, useT } from "../i18n";

// Program picker menu — entries are 100% plugin registrations (programRegistry, nothing built
// in, §2.6). Entries with the same path ("/" separated category path) group into a multi-level
// submenu tree (e.g. "Agents" ▸ Claude·Codex, "Agents/Experimental" ▸ …). The content + and the
// split tab bar + use it identically.
//   - body portal: inside a group cell (stacking context) fixed+z-index is covered by sibling
//     cells — the portal escapes all stacking/clipping and stays on top.
//   - Close = outside pointerdown (capture) + Escape. mouseLeave close was dropped (it closed on
//     a graze, and it never closed at all when the mouse never entered the menu).
//   - Blocks input below while open; native pane surfaces remain presented because the menu does not cover their geometry.

// Menu tree node — keeps registration order (a category's position = its first entry's position).
interface MenuNode {
  items: { id: string; title: string }[];
  subs: Map<string, MenuNode>; // category segment -> child node
  order: ({ kind: "item"; idx: number } | { kind: "sub"; name: string })[];
}

function emptyNode(): MenuNode {
  return { items: [], subs: new Map(), order: [] };
}

function insert(
  node: MenuNode,
  segs: string[],
  item: { id: string; title: string },
): void {
  if (segs.length === 0) {
    node.order.push({ kind: "item", idx: node.items.length });
    node.items.push(item);
    return;
  }
  const [head, ...rest] = segs;
  if (!node.subs.has(head)) {
    node.subs.set(head, emptyNode());
    node.order.push({ kind: "sub", name: head });
  }
  insert(node.subs.get(head)!, rest, item);
}

type Box = { left: number; top: number; right: number; bottom: number };

function MenuLevel({
  node,
  onPick,
  path,
  reportCover,
}: {
  node: MenuNode;
  onPick: (program: Program) => void;
  /** This level's place in the tree; a submenu's cover is reported under it. */
  path: string;
  /** What this level's open submenu covers, or null when none is open. */
  reportCover: (key: string, box: Box | null) => void;
}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  // Measured before paint on the state edge that opens or closes it: a cover is what is on
  // screen, never a width reserved for what might open.
  useLayoutEffect(() => {
    const el = openCategory ? submenuRef.current : null;
    if (!el) {
      reportCover(path, null);
      return;
    }
    const r = el.getBoundingClientRect();
    reportCover(path, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }, [openCategory, path, reportCover]);
  useEffect(() => () => reportCover(path, null), [path, reportCover]);
  return (
    <>
      {node.order.map((o) =>
        o.kind === "item" ? (
          <div
            key={node.items[o.idx].id}
            className="space-tab-menu-item"
            data-node={`menu/program/${node.items[o.idx].id}`}
            onClick={() => onPick(node.items[o.idx].id)}
          >
            {node.items[o.idx].title}
          </div>
        ) : (
          <div
            key={`sub:${o.name}`}
            className={`space-tab-menu-item has-sub${openCategory === o.name ? " open" : ""}`}
            data-node={`menu/category/${o.name}`}
            onClick={() => setOpenCategory((current) => current === o.name ? null : o.name)}
          >
            <span>{o.name}</span>
            <span className="space-tab-menu-caret icon-inline">
              <Icon name="chevron-right" size="sm" />
            </span>
            <div
              className="space-tab-submenu"
              ref={openCategory === o.name ? submenuRef : undefined}
              onClick={(event) => event.stopPropagation()}
            >
              <MenuLevel
                node={node.subs.get(o.name)!}
                onPick={onPick}
                path={`${path}/${o.name}`}
                reportCover={reportCover}
              />
            </div>
          </div>
        ),
      )}
    </>
  );
}

export function ProgramMenu({
  pos,
  within,
  anchor,
  onPick,
  onClose,
}: {
  pos: { left: number; top: number };
  /** The pane this menu belongs to, left to right: the body opens inside it, so a neighbour whose
   *  surface the menu never needs is never put through the swap. */
  within?: { left: number; right: number };
  /** The control that opened the menu. A pointer on it is not a pointer outside the menu: the
   *  control toggles the menu itself, and closing here as well made a second press close on
   *  mousedown and open again on click — the menu blinked and stayed (measured 2026-09-05). */
  anchor?: HTMLElement | null;
  onPick: (program: Program) => void;
  onClose: () => void;
}) {
  const t = useT();
  // The menu opens at a point inside the layout, which is where the native pane surfaces are. A
  // document overlay cannot be raised over one by any z-index (state/ui), so the surfaces are
  // occluded while it is open, exactly as every modal does.
  //
  // It declared the opposite until 2026-09-04, on the premise that the menu does not cover the pane
  // geometry. It opens over a pane and was drawn under it.
  const menuRef = useRef<HTMLDivElement>(null);
  // Position corrected into the viewport after measuring, plus whether the submenu flips.
  const [place, setPlace] = useState({ left: pos.left, top: pos.top, flip: false });
  // The box this menu covers, measured before paint. The overlay registers with it and not before:
  // registering first without it and again with it puts two edges on the overlay state, and every
  // pane parks, comes back and parks again between them. The picture that stands in for a surface
  // is then taken while the surface is off, and the pane shows a picture with nothing in it
  // (measured 2026-09-04).
  const [body, setBody] = useState<Box | null>(null);
  // Each level's open submenu, by its place in the tree. The cover is the body and these, and
  // nothing reserved for a submenu that is not open: reserving one put a pane to the right, whose
  // surface the menu never touched, through the swap (measured 2026-09-05).
  const [submenus, setSubmenus] = useState<ReadonlyMap<string, Box>>(() => new Map());
  const reportCover = useCallback((key: string, box: Box | null) => {
    setSubmenus((held) => {
      const current = held.get(key) ?? null;
      const same = current === box || (current && box && current.left === box.left
        && current.top === box.top && current.right === box.right && current.bottom === box.bottom);
      if (same) return held;
      const next = new Map(held);
      if (box) next.set(key, box);
      else next.delete(key);
      return next;
    });
  }, []);
  const covers = useMemo(() => {
    if (!body) return null;
    let box = { ...body };
    for (const sub of submenus.values()) {
      box = {
        left: Math.min(box.left, sub.left), top: Math.min(box.top, sub.top),
        right: Math.max(box.right, sub.right), bottom: Math.max(box.bottom, sub.bottom),
      };
    }
    return box;
  }, [body, submenus]);
  useOverlayActive(covers !== null, true, covers);
  // Subscribes to the register/unregister signal — a plugin enable toggle applies to an open menu too.
  useProgramRegistry((s) => s.version);
  const { programs, order } = useProgramRegistry.getState();

  useEffect(() => {
    // Capture phase — close is guaranteed even under another handler's stopPropagation. The click
    // that opened the menu finishes before this effect attaches, so there is no immediate close.
    const onOutsidePointer = (e: Event) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onOutsidePointer, true);
    window.addEventListener("mousedown", onOutsidePointer, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onOutsidePointer, true);
      window.removeEventListener("mousedown", onOutsidePointer, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose]);

  // When + is at the right/bottom edge, measure and pull the menu inward so the viewport does not
  // cut it off (useLayoutEffect = before paint, no flicker). If the submenu (opens right) would
  // overflow, flip opens it to the left.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const m = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = pos.left;
    let top = pos.top;
    // Inside its own pane first: opened at the + and wider than what was left of the strip, the
    // body ran past the pane into the card beside it, whose surface then stepped aside for a menu
    // that was not over it (measured 2026-09-05).
    if (within && left + w > within.right) left = Math.max(within.left, within.right - w);
    if (left + w > window.innerWidth - m)
      left = Math.max(m, window.innerWidth - m - w);
    if (top + h > window.innerHeight - m)
      top = Math.max(m, window.innerHeight - m - h);
    const flip = left + w + 130 > window.innerWidth - m;
    setPlace({ left, top, flip });
    setBody({ left, top, right: left + w, bottom: top + h });
  }, [pos.left, pos.top, within?.left, within?.right, order.length]);

  const root = emptyNode();
  for (const id of order) {
    const p = programs[id];
    if (!p) continue;
    insert(
      root,
      p.decl.path ? programPathSegments(localize(p.decl.path)) : [],
      { id, title: localize(p.decl.title) },
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className={place.flip ? "space-tab-menu flip-sub" : "space-tab-menu"}
      style={{ left: place.left, top: place.top }}
    >
      {order.length === 0 ? (
        <div className="space-tab-menu-empty">{t("program.empty")}</div>
      ) : (
        <MenuLevel node={root} onPick={onPick} path="" reportCover={reportCover} />
      )}
    </div>,
    document.body,
  );
}
