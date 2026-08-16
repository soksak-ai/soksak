// DOM address — the single truth of the structural path (pure, no I/O). It replaces arbitrary CSS
// selectors.
//
// Decision (duplication/idempotence/rule): an id scheme is unsuitable — counter ids (t1, g1) shift
// between runs (not idempotent), duplicate across windows, and force every element id to be
// globally unique. path + stable segments instead — a segment is not a counter id but a stable
// identifier (root/alias, region, position index/active, qualifiedViewId, node path). The
// hierarchical path is unique (0 duplication), stable segments are idempotent (consistent across
// runs), the structure is the rule (this module is the only source — no inline parsing).
//
// Grammar:
//   host view:   win/<label>/proj/<root|alias>/<region>/pane/<idx|active>/view/<pluginId.viewId>/tab/<tab-id>/node/<nodePath>
//   host chrome: win/<label>/proj/<root|alias>/chrome/<chromePath>
//   region ∈ { left | content | right }
// Omitted = active: no win = the current window, no proj = the active workspace, no pane = the
//              active pane, no tab = the only instance of that view key. Idempotent (consistent
//              against the active values).
//
// [Axiom] Uniqueness — two nodes exposed in one window cannot have the same address.
//   The same view key can be mounted twice (several browser tabs, a tab bar repeated per panel),
//   so a view key alone is not unique. The tab axis fills that place — without it resolve falls to
//   guessing "the visible one", and when both are visible even that guess collapses (measured: 6
//   panels all used tab/view/0). No guessing: 0 gives NOT_EXPOSED, 2 or more gives AMBIGUOUS.
// node/<nodePath> and chrome/<chromePath> allow multiple slash-separated segments (to the end).
// Everything else is a single token.

// The three regions of a window, and the one vocabulary for them: a placement declares one, an
// address names one, a view host is handed one. The middle one was "content" until 2026-08-16 — a
// role rather than a place, and the core holds no view about content (A1).
export const REGIONS = ["left", "center", "right"] as const;
export type Region = (typeof REGIONS)[number];

// Node/chrome path segments — alphanumerics, hyphen, dot (qualifiedViewId), slash (hierarchy),
// asterisk (a pattern is for declarations, an address holds instances). An instance address allows
// no asterisk. Each segment = [a-z0-9][a-z0-9.-]* (starts lowercase), joined with "/".
const SEG = /^[a-z0-9][a-z0-9.-]*$/;
export const NODE_PATH_RE = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;

export interface AddressParts {
  window?: string; // window label (omitted = the current window)
  // Host chrome path (chrome/...) — when present it excludes the view/node family.
  chrome?: string;
  // View context (when it is not chrome).
  workspace?: string; // root/alias (omitted = the active workspace)
  region?: Region; // left|content|right
  pane?: string; // position index or "active" (omitted = the active pane)
  view?: string; // qualifiedViewId(pluginId.viewId)
  // Tab id — the axis that establishes uniqueness when one view key is mounted several times.
  // Omitted = the only instance.
  tab?: string;
  node?: string; // plugin-exposed node path (slash-separated hierarchy)
}

function fail(msg: string): { error: string } {
  return { error: msg };
}

// Address string → structure. Malformed input gives { error }. No selector guessing — input
// outside the rule is rejected explicitly.
export function parseAddress(input: string): AddressParts | { error: string } {
  if (typeof input !== "string" || input.trim() === "") return fail("empty address");
  const segs = input.replace(/^\/+|\/+$/g, "").split("/");
  const out: AddressParts = {};
  let i = 0;

  // win/<label> (optional, first)
  if (segs[i] === "win") {
    const label = segs[i + 1];
    if (!label || !SEG.test(label)) return fail(`bad win label: ${label ?? "(none)"}`);
    out.window = label;
    i += 2;
  }

  if (i >= segs.length) return fail("no path after win");

  // proj/<id> (optional) — it also comes before chrome. Every workspace plane is mounted, so a
  // chrome node inside one exists once per workspace. Without this axis rail/left resolves to two
  // (measured).
  if (segs[i] === "proj") {
    const id = segs[i + 1];
    if (!id) return fail("no proj id");
    out.workspace = id; // root/alias allows any character (it can be a path) — taken as one segment only
    i += 2;
  }

  // chrome/<path...> (exclusive with the view family)
  if (segs[i] === "chrome") {
    const rest = segs.slice(i + 1).join("/");
    if (!rest) return fail("no chrome path");
    if (!NODE_PATH_RE.test(rest)) return fail(`bad chrome path: ${rest}`);
    out.chrome = rest;
    return out;
  }

  // region (optional, but recommended before view)
  if (i < segs.length && (REGIONS as readonly string[]).includes(segs[i])) {
    out.region = segs[i] as Region;
    i += 1;
  }

  // pane/<idx|active> (optional)
  if (segs[i] === "pane") {
    const p = segs[i + 1];
    if (!p || !(p === "active" || /^\d+$/.test(p))) return fail(`bad pane (idx|active): ${p ?? "(none)"}`);
    out.pane = p;
    i += 2;
  }

  // view/<pluginId.viewId> (optional)
  if (segs[i] === "view") {
    const v = segs[i + 1];
    if (!v || !SEG.test(v) || !v.includes(".")) return fail(`bad view key (pluginId.viewId): ${v ?? "(none)"}`);
    out.view = v;
    i += 2;
  }

  // tab/<tab-id> (optional) — only after view
  if (segs[i] === "tab") {
    const v = segs[i + 1];
    if (!v || !SEG.test(v)) return fail(`bad tab id: ${v ?? "(none)"}`);
    if (!out.view) return fail("tab comes only after view");
    out.tab = v;
    i += 2;
  }

  // node/<path...> (optional, to the end)
  if (segs[i] === "node") {
    const rest = segs.slice(i + 1).join("/");
    if (!rest) return fail("no node path");
    if (!NODE_PATH_RE.test(rest)) return fail(`bad node path: ${rest}`);
    out.node = rest;
    return out;
  }

  if (i < segs.length) return fail(`unknown segment: ${segs.slice(i).join("/")}`);
  return out;
}

// Structure → the canonical address string. Round-trip identity with parseAddress
// (parse∘format = structure). Omitted fields drop out of the path.
export function formatAddress(p: AddressParts): string {
  const segs: string[] = [];
  if (p.window) segs.push("win", p.window);
  if (p.chrome) {
    if (p.workspace) segs.push("proj", p.workspace);
    segs.push("chrome", p.chrome);
    return segs.join("/");
  }
  if (p.workspace) segs.push("proj", p.workspace);
  if (p.region) segs.push(p.region);
  if (p.pane) segs.push("pane", p.pane);
  if (p.view) segs.push("view", p.view);
  if (p.tab) segs.push("tab", p.tab);
  if (p.node) segs.push("node", p.node);
  return segs.join("/");
}

export function isParseError(r: AddressParts | { error: string }): r is { error: string } {
  return "error" in r;
}
