// pane invariant gate — the layout exposes exactly two entities: pane and tab.
//
// (a) What this gate enforces
//   ① A tab can exist only in a pane. Internal (split) nodes of the layout tree hold no tabs.
//   ② An empty pane is valid. A pane holds 0 or more tabs, and having no tab does not remove the position.
//      (This already holds — catalog.ts activeChain's "an empty panel is a valid position" and
//      emptyPanelContext.test.ts keep it. It is pinned here as well to stop this gate from later being
//      wrongly tightened into "no empty pane".)
//   ③ Internal node ids of the layout tree never appear on the address or command surface.
//      Internal nodes still exist as a data structure and still have internal ids, but they have no name.
//      Every gutter is addressed as the right/bottom edge of some pane, so there is no need to name an
//      internal node at all. Handing a caller something nameless leaves the caller no word for it, and that id
//      becomes invalid on restart (split ids are regenerated on restore — splitTree.ts serialization comment).
//
// (b) RED evidence (measured 2026-07-26, on the working copy). ③ is broken on all four axes.
//   ③-1 address surface 1  — GroupArea.tsx:786 `data-node={`divider/${d.splitId}/${d.index}`}`
//   ③-2 input surface 3    — sidebar.left.resize · panel.resize · panel.equalize take split as a
//                            parameter (catalog.ts:1133 · 1549 · 1573)
//   ③-3 response surface 1 — serializeLayout includes split node ids (catalog.ts:328).
//                            sidebar.left.tree returns leftLayout whole, so the same value leaks
//   ③-4 doc surface 4      — the descriptions and examples of sidebar.left.tree · sidebar.left.resize ·
//                            panel.resize · panel.equalize instruct the caller with split ids
//   ① and ② are GREEN today. The three are in one file because they are one invariant — "a tab is only in a
//   pane" and "a node outside a pane cannot be named" are two halves of the same sentence.
//
// (c) The shell queries that produced those counts (run from the repository root)
//   ③-1  grep -rn 'data-node={`[^`]*\${[^}]*splitId' src --include='*.tsx'
//   ③-2  grep -n 'split: { type: "string"' src/commands/catalog*.ts
//   ③-3  grep -n 'split: { id:' src/commands/catalog*.ts
//   ③-4  grep -niE 'splitId|split (node )?ids?' src/commands/catalog*.ts
//
// The registry cannot be built without the app, so the command surface is counted by reading the source
// (same approach as commandMessages.test.ts and windowAxis.test.ts). ① and ② are pure data structures, so
// an actual tree is built and checked.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allGroups, allViews, type Tab, type Pane, type Space } from "./sessions";
import { rowPlane } from "../test/planes";

const SRC_ROOT = join(__dirname, "..");
const CATALOG_DIR = join(SRC_ROOT, "commands");

// ── Fixture: layout tree ─────────────────────────────────────────────────────
const tab = (id: string): Tab => ({
  id,
  kind: "plugin",
  title: id,
  pluginId: "p",
  view: "content",
});
const pane = (id: string, tabs: Tab[]): Pane => ({
  id,
  tabs,
  activeTabId: tabs[0]?.id ?? "",
});
/** A space over these panes, side by side. */
const spaceOf = (panes: Pane[]): Space => ({
  id: "spc-a",
  title: "1",
  panes,
  layout: rowPlane(panes.map((g) => g.id)),
  activePaneId: panes[0]?.id ?? "",
});

/** Scrapes every node holding tabs out of the whole tree — only leaves must come out. */
function nodesHoldingTabs(node: unknown, acc: object[] = []): object[] {
  if (Array.isArray(node)) {
    for (const item of node) nodesHoldingTabs(item, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    if (Array.isArray((node as { tabs?: unknown }).tabs)) acc.push(node as object);
    for (const v of Object.values(node)) nodesHoldingTabs(v, acc);
  }
  return acc;
}

// ── Source scan ──────────────────────────────────────────────────────────────
function filesUnder(dir: string, re: RegExp, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, re, acc);
    else if (re.test(e.name) && !e.name.includes(".test.")) acc.push(p);
  }
  return acc;
}

const rel = (p: string) => p.slice(SRC_ROOT.length - "src".length);
const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

/** Every data-node address in src/**\/*.tsx — in the form `file:line value`. */
function domAddresses(): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  for (const f of filesUnder(SRC_ROOT, /\.tsx$/)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/data-node=(?:\{`([^`]*)`\}|"([^"]*)")/g)) {
      out.push({
        where: `${rel(f)}:${lineOf(src, m.index ?? 0)}`,
        value: m[1] ?? m[2] ?? "",
      });
    }
  }
  return out;
}

const catalogFiles = () => filesUnder(CATALOG_DIR, /^catalog.*\.ts$/);

/** The register("<name>", { ... }) block — up to the next register (same cut as windowAxis.test.ts). */
function blocks(): { name: string; body: string; where: string }[] {
  const out: { name: string; body: string; where: string }[] = [];
  for (const f of catalogFiles()) {
    const src = readFileSync(f, "utf8");
    const marks = [...src.matchAll(/ {2}register\("([^"]+)", \{/g)];
    marks.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      out.push({
        name: m[1],
        body: src.slice(start, end),
        where: `${rel(f)}:${lineOf(src, start)}`,
      });
    });
  }
  return out;
}

/** The declared parameter section only — the returns text and handler body are not mistaken for parameters. */
function paramsOf(body: string): string {
  const i = body.indexOf("params:");
  if (i < 0) return "";
  const j = body.indexOf("returns:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

/** description, parameter descriptions and examples = the doc surface the caller reads. The handler body is excluded. */
function docSurfaceOf(body: string): string {
  const i = body.indexOf("description:");
  if (i < 0) return "";
  const j = body.indexOf("handler:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

// Words that name an internal node id — splitId / split id / split ids / split node id.
const INNER_NODE_ID = /splitId|split\s+(?:node\s+)?ids?\b/i;

// ── ① A tab is only in a pane ────────────────────────────────────────────────
describe("① a tab exists only in a pane", () => {
  const a = pane("pan-a", [tab("tab-1"), tab("tab-2")]);
  const b = pane("pan-b", [tab("tab-3")]);
  const space = spaceOf([a, b, pane("pan-c", [])]);

  it("every node holding tabs is a pane — the plane holds none", () => {
    expect(nodesHoldingTabs(space)).toEqual(space.panes);
    expect(nodesHoldingTabs(space.layout)).toEqual([]);
  });

  it("a card on the plane has no slot for a tab at all", () => {
    // The library's card has a host payload slot; the core leaves it empty.
    const offenders = space.layout.cards.filter((card) => "tabs" in card || "value" in card || card.data !== undefined);
    expect(offenders).toEqual([]);
  });

  it("every tab in the layout is exactly the union of the tabs the panes hold", () => {
    expect(allViews(space)).toEqual(allGroups(space).flatMap((g) => g.tabs));
    expect(allViews(space).map((v) => v.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
  });
});

// ── ② An empty pane is valid ─────────────────────────────────────────────────
describe("② an empty pane is valid — 0 or more tabs", () => {
  it("a pane with 0 tabs is collected as a pane too", () => {
    const empty = pane("pan-empty", []);
    const space = spaceOf([pane("pan-a", [tab("tab-1")]), empty]);
    expect(allGroups(space).map((g) => g.id)).toEqual(["pan-a", "pan-empty"]);
    expect(allViews(space).map((v) => v.id)).toEqual(["tab-1"]);
  });

  it("a layout with no tab at all is still a layout", () => {
    const space = spaceOf([pane("pan-empty", [])]);
    expect(allGroups(space).map((g) => g.id)).toEqual(["pan-empty"]);
    expect(allViews(space)).toEqual([]);
  });

  it("the active chain does not drop the position when a tab is absent — it cuts at the pane", () => {
    const src = readFileSync(join(CATALOG_DIR, "catalog.ts"), "utf8");
    const i = src.indexOf("function activeChain(");
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf("\nfunction ", i + 1);
    const body = src.slice(i, j < 0 ? src.length : j);
    // No pane means no position (cut). No tab is normal, so it does not cut.
    expect(/if \(!pane\) return null;/.test(body)).toBe(true);
    expect(/if \(!tab\) return null;/.test(body)).toBe(false);
  });
});

// ── ③ No internal node id on the address or command surface ──────────────────
describe("③ no layout-tree internal node id appears on the address or command surface", () => {
  it("the scan actually reads something — an empty set is not counted as a pass", () => {
    expect(domAddresses().length).toBeGreaterThan(50);
    expect(blocks().length).toBeGreaterThan(50);
  });

  it("③-1 a DOM address does not include an internal node id", () => {
    const offenders = domAddresses()
      .filter((a) => INNER_NODE_ID.test(a.value))
      .map((a) => `${a.where} ${a.value}`);
    expect(offenders).toEqual([]);
  });

  it("③-2 no command takes an internal node id as a parameter", () => {
    const offenders = blocks()
      .filter((b) => /\bsplit:\s*\{/.test(paramsOf(b.body)))
      .map((b) => `${b.name} (${b.where})`);
    expect(offenders).toEqual([]);
  });

  it("③-3 a command response does not include an internal node id", () => {
    const offenders: string[] = [];
    for (const f of catalogFiles()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bsplit:\s*\{\s*id:/g)) {
        offenders.push(`${rel(f)}:${lineOf(src, m.index ?? 0)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("③-4 no command description or example instructs the caller with an internal node id", () => {
    const offenders = blocks()
      .filter((b) => INNER_NODE_ID.test(docSurfaceOf(b.body)))
      .map((b) => `${b.name} (${b.where})`);
    expect(offenders).toEqual([]);
  });
});
