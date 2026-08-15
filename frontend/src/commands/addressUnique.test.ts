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
    mountView("content/view/p.browser/tab/tab-aaaaaa", ["urlbar"]);
    mountView("content/view/p.browser/tab/tab-bbbbbb", ["urlbar"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

describe("A2 no guessing — 0 matches is absent, 2 or more is ambiguous", () => {
  it("a unique match is returned", () => {
    mountView("content/view/p.browser/tab/tab-aaaaaa", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/tab/tab-aaaaaa/node/urlbar");
    expect("el" in r).toBe(true);
  });

  it("no match answers NOT_EXPOSED and does not guess with a selector", () => {
    const r = resolveExposed("content/view/p.browser/tab/tab-aaaaaa/node/urlbar");
    expect(r).toMatchObject({ code: "NOT_EXPOSED" });
  });

  it("two matches answer AMBIGUOUS and do not pick the visible one", () => {
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/node/urlbar");
    expect(r).toMatchObject({ code: "AMBIGUOUS" });
  });

  it("the ambiguous message reports how many matched — an answer must be diagnosable to be fixable", () => {
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/node/urlbar");
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
    plane("t1", true, ["rail/left"]);
    plane("t2", false, ["rail/left"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    // The window prefix is added only when a name exists, so the address may start with `proj/`. What this
    // check pins down is that the workspace axis is present, not what precedes it.
    expect(addrs.some((a) => a.endsWith("proj/t1/chrome/rail/left"))).toBe(true);
    expect(addrs.some((a) => a.endsWith("proj/t2/chrome/rail/left"))).toBe(true);
  });

  it("the short form resolves to the active workspace — omitted means active in this syntax", () => {
    plane("t1", true, ["rail/left"]);
    plane("t2", false, ["rail/left"]);
    const r = resolveExposed("chrome/rail/left");
    expect("el" in r).toBe(true);
    if ("el" in r) {
      expect(r.el.closest("[data-workspace-plane]")?.getAttribute("data-workspace-plane")).toBe("t1");
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
