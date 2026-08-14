// What paints over what — the answer is a chain, not a single z.
//
// The left rail and the focus light are not in the same stacking context. The light is inside the
// context created by .space-plane, and the left rail moves below that sibling. The rail's exemption
// from the light is owned by the exact rail geometry in the light mask, not by a higher z. The right
// sidebar, modals, and global chrome form a separate chain.
//
// So this module does not compare. It returns the ancestor chain that fixes paint order as a value,
// and the caller compares. A verdict without a chain is "unreadable", not "same layer".

/** Computed declarations used for the context verdict. A subset of CSSStyleDeclaration. */
export interface StackingComputedStyle {
  position: string;
  zIndex: string;
  opacity: string;
  transform: string;
  filter: string;
  backdropFilter: string;
  perspective: string;
  clipPath: string;
  maskImage: string;
  isolation: string;
  mixBlendMode: string;
  willChange: string;
  contain: string;
}

/** One step of the chain — where this element stands inside its parent context. */
export interface StackingPathEntry {
  /** Opaque live-Element token, the same one ui.tree uses. Finds the common ancestor of two chains. */
  identity: string;
  /** Exposed data-node name. Diagnostic only, not a verdict axis. */
  node: string | null;
  /** Declared layer. auto declares no layer, so it is null, not 0. */
  zIndex: number | null;
  /** Is this a positioned box — an in-flow box paints below a z:0 positioned box in the same context. */
  positioned: boolean;
  /** Chain of child indexes from the root. Where layers are equal, document order breaks the tie. */
  order: number[];
}

function layerRank(entry: StackingPathEntry): number {
  if (entry.zIndex !== null) return entry.zIndex;
  return entry.positioned ? 0 : -0.5;
}

/** 1 when a paints over b, -1 when below, 0 for the same node, null when they are ancestor-related and this axis cannot separate them. */
export function compareStackingPaths(
  a: readonly StackingPathEntry[],
  b: readonly StackingPathEntry[],
): -1 | 0 | 1 | null {
  if (a.length === 0 || b.length === 0) return null;
  let index = 0;
  while (index < a.length && index < b.length && a[index].identity === b[index].identity) {
    index += 1;
  }
  if (index === a.length && index === b.length) return 0;
  if (index === a.length || index === b.length) return null;
  const left = layerRank(a[index]);
  const right = layerRank(b[index]);
  if (left !== right) return left > right ? 1 : -1;
  const leftOrder = a[index].order;
  const rightOrder = b[index].order;
  const limit = Math.min(leftOrder.length, rightOrder.length);
  for (let cursor = 0; cursor < limit; cursor += 1) {
    if (leftOrder[cursor] !== rightOrder[cursor]) {
      return leftOrder[cursor] > rightOrder[cursor] ? 1 : -1;
    }
  }
  return leftOrder.length === rightOrder.length
    ? null
    : leftOrder.length > rightOrder.length ? 1 : -1;
}

const isNone = (value: string | undefined): boolean => !value || value === "none";

/** Declared layer. `auto` declares no layer, so it is null rather than a number. */
export function declaredLayer(zIndex: string | undefined): number | null {
  if (!zIndex || zIndex === "auto") return null;
  const order = Number.parseInt(zIndex, 10);
  return Number.isFinite(order) ? order : null;
}

/**
 * Does this declaration create its own stacking context.
 *
 * If it does, descendant z values do not leak outside — that is what "contains" means, and why a
 * verdict that compares two numbers directly is wrong.
 */
export function establishesStackingContext(
  style: Partial<StackingComputedStyle>,
  { isRoot = false, parentDisplay = "" }: { isRoot?: boolean; parentDisplay?: string } = {},
): boolean {
  if (isRoot) return true;
  const position = style.position ?? "static";
  const zIndex = style.zIndex ?? "auto";
  if (position === "fixed" || position === "sticky") return true;
  if (position !== "static" && zIndex !== "auto") return true;
  // A flex/grid item creates a context when it declares z, even without being positioned.
  if (/\b(flex|grid|inline-flex|inline-grid)\b/.test(parentDisplay) && zIndex !== "auto") return true;
  const opacity = Number.parseFloat(style.opacity ?? "1");
  if (Number.isFinite(opacity) && opacity < 1) return true;
  for (const value of [
    style.transform,
    style.filter,
    style.backdropFilter,
    style.perspective,
    style.clipPath,
    style.maskImage,
  ]) {
    if (!isNone(value)) return true;
  }
  if (style.isolation === "isolate") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  if (/opacity|transform|filter|perspective|isolation|z-index/.test(style.willChange ?? "")) return true;
  if (/\b(paint|layout|strict|content)\b/.test(style.contain ?? "")) return true;
  return false;
}

/**
 * The ancestor chain that fixes this element's paint order — from the root down to itself.
 *
 * Three kinds of step are included: an ancestor that creates a context (it contains its descendants),
 * a positioned ancestor (it has an order inside the same context), and the element itself. Other
 * ancestors do not change order, so they are left out.
 */
export function stackingPathOf(
  el: Element,
  {
    getStyle,
    identify,
  }: {
    getStyle: (node: Element) => Partial<StackingComputedStyle> & { display?: string };
    identify: (node: Element) => string;
  },
): StackingPathEntry[] {
  const chain: Element[] = [];
  for (let cursor: Element | null = el; cursor; cursor = cursor.parentElement) chain.push(cursor);
  chain.reverse();

  const order: number[] = [];
  const path: StackingPathEntry[] = [];
  for (const cursor of chain) {
    const parent = cursor.parentElement;
    order.push(parent ? Array.prototype.indexOf.call(parent.children, cursor) : 0);
    const style = getStyle(cursor);
    const positioned = (style.position ?? "static") !== "static";
    const establishes = establishesStackingContext(style, {
      isRoot: parent === null,
      parentDisplay: parent ? (getStyle(parent).display ?? "") : "",
    });
    if (cursor !== el && !positioned && !establishes) continue;
    path.push({
      identity: identify(cursor),
      node: (cursor as HTMLElement).dataset?.node ?? null,
      zIndex: declaredLayer(style.zIndex),
      positioned,
      order: [...order],
    });
  }
  return path;
}
