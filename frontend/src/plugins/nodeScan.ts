// Node scan — collects DOM elements exposed with data-node inside a plugin view container as
// absolute addresses. Scan root = .tab-viewer of PluginViewHost (single truth). Host chrome
// follows the same data-node rule.
//
// Exposure is explicit (the data-node attribute). An unexposed element is not collected → absent
// from the address tree → NOT_EXPOSED on access.
// A dynamic list uses data-node="<id>/<key>". querySelectorAll does not cross a Shadow DOM (erd)
// boundary, so the traversal recurses.

import { NODE_PATH_RE } from "../commands/address";
import { nodeConformance } from "./conformance";

export interface ScannedNode {
  address: string; // Canonical absolute address — unique (address axiom A1)
  nodePath: string; // data-node value
  el: HTMLElement; // The element itself (used directly on resolve)
  // Short-form alias (the grammar's "omitted = active"). Only chrome of the active project gets
  // one — the canonical form is always address.
  alias?: string;
}

// Collects every [data-node] element under root, Shadow DOM included: light DOM querySelectorAll + recursion into each shadowRoot.
function collectDataNodes(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll<HTMLElement>("[data-node]")) {
      out.push(el);
    }
    // shadowRoot recursion — querySelectorAll does not cross the boundary. Traverse the shadowRoot of every child.
    for (const el of node.querySelectorAll<HTMLElement>("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    if ((node as Element).shadowRoot) walk((node as Element).shadowRoot!);
  };
  walk(root);
  return out;
}

// Exposed nodes inside container, as absolute addresses. baseAddress = this view's address
// (.../view/<pluginId.viewId>).
// A malformed path (violates NODE_PATH_RE) is reported through onWarn and skipped (no silent
// failure, §0-3).
export function scanNodes(
  container: ParentNode,
  baseAddress: string,
  onWarn?: (msg: string) => void,
  declaredNodeIds?: readonly string[],
): ScannedNode[] {
  const seen = new Set<string>();
  const out: ScannedNode[] = [];
  for (const el of collectDataNodes(container)) {
    const nodePath = el.dataset.node ?? "";
    if (!NODE_PATH_RE.test(nodePath)) {
      onWarn?.(`data-node path malformed (skipped): "${nodePath}" @ ${baseAddress}`);
      continue;
    }
    if (seen.has(nodePath)) {
      onWarn?.(`data-node duplicate (skipped): "${nodePath}" @ ${baseAddress}`);
      continue;
    }
    seen.add(nodePath);
    out.push({ address: `${baseAddress}/node/${nodePath}`, nodePath, el });
  }
  // [conformance] declaration (contributes.nodes) ≡ wiring (data-node) — diagnosed only when
  // declaredNodeIds is passed. nodes has no register API and cannot be gated, so warnings expose
  // the mismatch in both directions (zero concealment).
  if (declaredNodeIds) {
    const { missing, orphan } = nodeConformance(
      declaredNodeIds,
      out.map((n) => n.nodePath),
    );
    if (missing.length)
      onWarn?.(`declared-but-not-wired: [${missing.join(",")}] @ ${baseAddress}`);
    if (orphan.length)
      onWarn?.(`wired-but-not-declared: [${orphan.join(",")}] @ ${baseAddress}`);
  }
  return out;
}
