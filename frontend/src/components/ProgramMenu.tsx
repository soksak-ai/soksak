import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

function MenuLevel({
  node,
  onPick,
}: {
  node: MenuNode;
  onPick: (program: Program) => void;
}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
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
            <div className="space-tab-submenu" onClick={(event) => event.stopPropagation()}>
              <MenuLevel node={node.subs.get(o.name)!} onPick={onPick} />
            </div>
          </div>
        ),
      )}
    </>
  );
}

export function ProgramMenu({
  pos,
  onPick,
  onClose,
}: {
  pos: { left: number; top: number };
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
  const [covers, setCovers] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  useOverlayActive(covers !== null, true, covers);
  // Subscribes to the register/unregister signal — a plugin enable toggle applies to an open menu too.
  useProgramRegistry((s) => s.version);
  const { programs, order } = useProgramRegistry.getState();

  useEffect(() => {
    // Capture phase — close is guaranteed even under another handler's stopPropagation. The click
    // that opened the menu finishes before this effect attaches, so there is no immediate close.
    const onOutsidePointer = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
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
  }, [onClose]);

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
    if (left + w > window.innerWidth - m)
      left = Math.max(m, window.innerWidth - m - w);
    if (top + h > window.innerHeight - m)
      top = Math.max(m, window.innerHeight - m - h);
    const flip = left + w + 130 > window.innerWidth - m;
    setPlace({ left, top, flip });
    // A submenu opens beside the body and is part of what the menu covers. Its width is the same
    // 130 the flip test uses; taking the body alone would leave a surface over an open submenu.
    const sub = 130;
    setCovers({
      left: flip ? left - sub : left,
      top,
      right: flip ? left + w : left + w + sub,
      bottom: top + h,
    });
  }, [pos.left, pos.top, order.length]);

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
        <MenuLevel node={root} onPick={onPick} />
      )}
    </div>,
    document.body,
  );
}
