// Address axioms A1 and A2 — uniqueness and no guessing.
//
// RED evidence (measured, 2026-07-26): 85 of the 779 exposed nodes in a live window shared an address
// (tab/view/0 once in each of 6 panels, 3 browser views on the same urlbar address). resolve guessed by
// picking the "visible" one, and now that every panel is visible even that guess breaks down — nothing
// determines which panel a click goes to.
//
// The contract already declares "the hierarchical path is unique (zero duplicates)". Declared, never enforced.
// Enforced here: with two nodes on one address, pick neither and reject with AMBIGUOUS.
import { beforeEach, describe, expect, it } from "vitest";
import { resolveExposed, collectExposed } from "./catalogDom";

function mountView(addr: string, nodes: string[]): void {
  const c = document.createElement("div");
  c.className = "tab-viewer";
  c.dataset.viewAddr = addr;
  for (const n of nodes) {
    const el = document.createElement("div");
    el.setAttribute("data-node", n);
    c.appendChild(el);
  }
  document.body.appendChild(c);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("A1 uniqueness — two nodes cannot hold the same address", () => {
  it("mounting the same view key twice keeps the addresses apart on the inst axis", () => {
    mountView("center/view/p.browser/tab/tab-aaaaaa", ["urlbar"]);
    mountView("center/view/p.browser/tab/tab-bbbbbb", ["urlbar"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

describe("A1 uniqueness — a scan root inside a workspace plane includes the workspace axis", () => {
  function mountPlane(proj: string, active: boolean, addr: string, overlay: boolean): void {
    const plane = document.createElement("div");
    plane.dataset.workspacePlane = proj;
    if (active) plane.dataset.workspaceActive = "1";
    const c = document.createElement("div");
    if (overlay) {
      c.dataset.viewOverlayAddr = addr;
    } else {
      c.className = "tab-viewer";
      c.dataset.viewAddr = addr;
    }
    const el = document.createElement("div");
    el.setAttribute("data-node", overlay ? "plugin-view-error" : "row");
    c.appendChild(el);
    plane.appendChild(c);
    document.body.appendChild(plane);
  }
  it("two planes with the same sidebar view address list two canonical nodes and one alias", () => {
    mountPlane("p1", true, "left/view/p.tree", false);
    mountPlane("p2", false, "left/view/p.tree", false);
    const nodes = collectExposed();
    const addrs = nodes.map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(addrs).toContain("proj/p1/left/view/p.tree/node/row");
    expect(addrs).toContain("proj/p2/left/view/p.tree/node/row");
    expect(nodes.filter((n) => n.alias === "left/view/p.tree/node/row")).toHaveLength(1);
    const r = resolveExposed("left/view/p.tree/node/row");
    expect("el" in r).toBe(true);
    if ("el" in r) expect(r.el.closest("[data-workspace-plane]")?.getAttribute("data-workspace-plane")).toBe("p1");
  });
  it("the overlay of a sidebar view follows the same axis", () => {
    mountPlane("p1", true, "left/view/p.tree", true);
    mountPlane("p2", false, "left/view/p.tree", true);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(addrs).toContain("proj/p2/left/view/p.tree/node/plugin-view-error");
    const r = resolveExposed("left/view/p.tree/node/plugin-view-error");
    expect("el" in r).toBe(true);
    if ("el" in r) expect(r.el.closest("[data-workspace-plane]")?.getAttribute("data-workspace-plane")).toBe("p1");
  });
});

describe("A2 no guessing — 0 matches is absent, 2 or more is ambiguous", () => {
  it("a unique match is returned", () => {
    mountView("center/view/p.browser/tab/tab-aaaaaa", ["urlbar"]);
    const r = resolveExposed("center/view/p.browser/tab/tab-aaaaaa/node/urlbar");
    expect("el" in r).toBe(true);
  });

  it("no match answers NOT_EXPOSED and does not guess with a selector", () => {
    const r = resolveExposed("center/view/p.browser/tab/tab-aaaaaa/node/urlbar");
    expect(r).toMatchObject({ code: "NOT_EXPOSED" });
  });

  it("two matches answer AMBIGUOUS and do not pick the visible one", () => {
    mountView("center/view/p.browser", ["urlbar"]);
    mountView("center/view/p.browser", ["urlbar"]);
    const r = resolveExposed("center/view/p.browser/node/urlbar");
    expect(r).toMatchObject({ code: "AMBIGUOUS" });
  });

  it("the ambiguous message reports how many matched — an answer must be diagnosable to be fixable", () => {
    mountView("center/view/p.browser", ["urlbar"]);
    mountView("center/view/p.browser", ["urlbar"]);
    mountView("center/view/p.browser", ["urlbar"]);
    const r = resolveExposed("center/view/p.browser/node/urlbar");
    expect("message" in r && r.message).toMatch(/3/);
  });
});

describe("A1 uniqueness — chrome addresses stay distinct with every workspace plane mounted", () => {
  // RED evidence (measured, 2026-07-26): every workspace stays mounted to keep its session (inactive ones parked
  // off screen), so one set of chrome nodes exists per workspace inside the plane. rail/left, tab/space/0, and
  // bodywrap each resolved to two — the same axis as "the sidebar appears twice".
  function plane(projectId: string, active: boolean, nodes: string[]): void {
    const p = document.createElement("div");
    p.dataset.workspacePlane = projectId;
    if (active) p.dataset.workspaceActive = "1";
    for (const n of nodes) {
      const el = document.createElement("div");
      el.setAttribute("data-node", n);
      p.appendChild(el);
    }
    document.body.appendChild(p);
  }

  it("the canonical address includes the workspace axis", () => {
    plane("wsp-4h7kq2", true, ["rail/left"]);
    plane("wsp-9m3xb5", false, ["rail/left"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    // The window prefix is added only when a name exists, so the address may start with `proj/`. What this
    // check pins down is that the workspace axis is present, not what precedes it.
    expect(addrs.some((a) => a.endsWith("proj/wsp-4h7kq2/chrome/rail/left"))).toBe(true);
    expect(addrs.some((a) => a.endsWith("proj/wsp-9m3xb5/chrome/rail/left"))).toBe(true);
  });

  it("the short form resolves to the active workspace — omitted means active in this syntax", () => {
    plane("wsp-4h7kq2", true, ["rail/left"]);
    plane("wsp-9m3xb5", false, ["rail/left"]);
    const r = resolveExposed("chrome/rail/left");
    expect("el" in r).toBe(true);
    if ("el" in r) {
      expect(r.el.closest("[data-workspace-plane]")?.getAttribute("data-workspace-plane")).toBe("wsp-4h7kq2");
    }
  });

  it("chrome outside a plane (window-global) has no workspace axis", () => {
    const el = document.createElement("div");
    el.setAttribute("data-node", "window/empty");
    document.body.appendChild(el);
    // What this pins down is that the workspace axis is **absent**. The window prefix is added only when a name
    // exists, so the address may start with `chrome/`.
    const addrs = collectExposed().map((n) => n.address);
    expect(addrs.some((a) => a.endsWith("chrome/window/empty"))).toBe(true);
    expect(addrs.every((a) => !a.includes("/proj/"))).toBe(true);
  });
});

describe("A1 uniqueness — the view container and its overlay share one view address", () => {
  // The PluginViewHost overlay (loading, placeholder, error) is a sibling of the provider container.
  // It declares data-view-overlay-addr with the container's view address and its own data-node: a
  // node-scan root under that address, never a chrome node, and never a second holder of
  // data-view-addr (ui.slot resolves that attribute; A2 needs one element per address).
  function mountOverlay(addr: string, node: string): void {
    const el = document.createElement("div");
    el.dataset.viewOverlayAddr = addr;
    el.setAttribute("data-node", node);
    document.body.appendChild(el);
  }

  it("the overlay node is listed once under the view address and not as chrome", () => {
    mountView("center/view/p.tree/tab/tab-aaaaaa", ["urlbar"]);
    mountOverlay("center/view/p.tree/tab/tab-aaaaaa", "plugin-view-placeholder");
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(addrs.some((a) => a.endsWith("center/view/p.tree/tab/tab-aaaaaa/node/plugin-view-placeholder"))).toBe(true);
    expect(addrs.some((a) => a.endsWith("center/view/p.tree/tab/tab-aaaaaa/node/urlbar"))).toBe(true);
    expect(addrs.every((a) => !a.includes("chrome/"))).toBe(true);
    expect(document.querySelectorAll("[data-view-addr]")).toHaveLength(1);
  });

  it("the overlay node resolves by its view address", () => {
    mountView("center/view/p.tree/tab/tab-aaaaaa", []);
    mountOverlay("center/view/p.tree/tab/tab-aaaaaa", "plugin-view-placeholder");
    const r = resolveExposed("center/view/p.tree/tab/tab-aaaaaa/node/plugin-view-placeholder");
    expect("el" in r).toBe(true);
    if ("el" in r) expect(r.el.dataset.viewOverlayAddr).toBe("center/view/p.tree/tab/tab-aaaaaa");
  });
});
