// The program menu as a native menu, above every native surface.
//
// The program menu's item tree, built the same way ProgramMenu builds it, so the overlay menu and
// the document menu are the same programs in the same order. The overlay menu (state/overlayMenu,
// lib/overlayMenuPage) renders it in a native webview surface above every terminal, so opening it
// parks nothing and there is no document-picture swap to shimmer (the defect measured 2026-09-05).
import { localize } from "../i18n";
import { useProgramRegistry } from "../plugins/programRegistry";
import { programPathSegments } from "../plugins/spec";

export interface NativeMenuItem {
  /** A leaf has the program id; a category has none. */
  id?: string;
  label: string;
  /** A category's children; absent or empty on a leaf. */
  items?: NativeMenuItem[];
}

interface MenuNode {
  items: { id: string; label: string }[];
  subs: Map<string, MenuNode>;
  order: ({ kind: "item"; idx: number } | { kind: "sub"; name: string })[];
}

const emptyNode = (): MenuNode => ({ items: [], subs: new Map(), order: [] });

function insert(node: MenuNode, segs: string[], leaf: { id: string; label: string }): void {
  if (segs.length === 0) {
    node.order.push({ kind: "item", idx: node.items.length });
    node.items.push(leaf);
    return;
  }
  const [head, ...rest] = segs;
  if (!node.subs.has(head)) {
    node.subs.set(head, emptyNode());
    node.order.push({ kind: "sub", name: head });
  }
  insert(node.subs.get(head)!, rest, leaf);
}

function serialize(node: MenuNode): NativeMenuItem[] {
  return node.order.map((entry) =>
    entry.kind === "item"
      ? { id: node.items[entry.idx].id, label: node.items[entry.idx].label }
      : { label: entry.name, items: serialize(node.subs.get(entry.name)!) },
  );
}

/** The program menu tree, in registration order, as the native menu items. */
export function programMenuItems(): NativeMenuItem[] {
  const { programs, order } = useProgramRegistry.getState();
  const root = emptyNode();
  for (const id of order) {
    const p = programs[id];
    if (!p) continue;
    insert(
      root,
      p.decl.path ? programPathSegments(localize(p.decl.path)) : [],
      { id, label: localize(p.decl.title) },
    );
  }
  return serialize(root);
}
