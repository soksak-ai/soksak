// @vitest-environment jsdom
// Contract for the 3-option relation-surface switch (railRelation: tint|moment|stroke) — a temporary axis for
// comparison. Once decided, keep only the adopted option and delete this switch with the mode CSS branches.
//  - tint (default): mode class relation-tint, no stroke or label, only a low-density accent fill (CSS branch).
//  - moment: 600ms flash then fade-out, only at the instant the binding identity (boundViewId/targetRect) changes.
//  - stroke: unchanged (the reference point).
//  - common: when the rail is not adjacent to the bound cell (logical gap over 1%p), the relation surface is not
//    rendered at all.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom localStorage does not work → Map stub (precedent: settings.test). The contract is: before the settings import.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

vi.mock("../state/theme", () => ({
  useTheme: (select: (state: unknown) => unknown) =>
    select({ spec: { relation: { radius: 12, strokeWidth: 1.5 } } }),
}));
// Only the translation is replaced. A mock of the whole module has to grow every time i18n gains
// an export, and the failure then names the mock rather than the change that caused it.
vi.mock("../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n")>()),
  useT: () => () => "LINKED",
}));

import { RailLinkOverlay } from "./RailLinkOverlay";
import type { RailRelationState } from "../lib/railArrangement";
import { classifyRailRelation } from "../lib/railLinkShape";
import { useSettings } from "../state/settings";
import { styleSurfaceRules } from "../ui/styleSurface";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const adjacentRect = { left: 50, top: 0, width: 25, height: 50 };

function overlayProps(overrides: Partial<{
  boundViewId: string;
  railStation: number;
  targetRect: typeof adjacentRect | null;
  placementMode: "flow" | "pin";
  relation: Partial<RailRelationState>;
}> = {}) {
  const boundViewId = overrides.boundViewId ?? "v2";
  const railStation = overrides.railStation ?? 50;
  const targetRect = overrides.targetRect === undefined ? adjacentRect : overrides.targetRect;
  const placement = overrides.placementMode ?? "flow";
  const side = targetRect
    ? classifyRailRelation(railStation, targetRect)
    : "detached";
  const connected = side !== "detached";
  const relation: RailRelationState = {
    boundTabId: targetRect ? boundViewId : null,
    boundPaneId: targetRect ? "g2" : null,
    source: targetRect ? "focus" : "none",
    relationId: targetRect
      ? `rail-relation/c1/g2/${boundViewId}`
      : "rail-relation/c1/none",
    placement,
    connected,
    side,
    borderMode: connected ? "union" : targetRect ? "independent" : "none",
    pathCount: connected ? 1 : targetRect ? 2 : 0,
    ...overrides.relation,
  };
  return {
    contentId: "c1",
    relation,
    railWidth: 300,
    railStation,
    targetRect,
  };
}

describe("RailLinkOverlay — the railRelation three-way switch", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1200,
        bottom: 800, width: 1200, height: 800,
        toJSON: () => ({}),
      }),
    );
    useSettings.setState({ railRelation: "tint" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("the default is tint — the root gets the relation-tint mode class", () => {
    // The setting axis's own default is tint too (store DEFAULTS).
    expect(useSettings.getState().railRelation).toBe("tint");
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.classList.contains("relation-tint")).toBe(true);
    expect(overlay.dataset.flash).toBeUndefined();
  });

  it("a railRelation switch shows up as the mode class (relation-moment|relation-stroke)", () => {
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    act(() => useSettings.setState({ railRelation: "stroke" }));
    expect(
      host.querySelector(".rail-link-overlay.relation-stroke"),
    ).not.toBeNull();
    act(() => useSettings.setState({ railRelation: "moment" }));
    expect(
      host.querySelector(".rail-link-overlay.relation-moment"),
    ).not.toBeNull();
    expect(host.querySelectorAll(".rail-link-overlay")).toHaveLength(1);
  });

  it("with no binding, none/0 keeps only the public root in every mode and draws no path", () => {
    for (const mode of ["tint", "moment", "stroke"] as const) {
      useSettings.setState({ railRelation: mode });
      act(() =>
        root.render(
          <RailLinkOverlay
            {...overlayProps({ targetRect: null })}
            key={mode}
          />,
        ),
      );
      const relation = host.querySelector<HTMLElement>(".rail-link-overlay");
      expect(relation?.dataset).toMatchObject({
        borderMode: "none",
        pathCount: "0",
        relationId: "rail-relation/c1/none",
      });
      expect(relation?.querySelector("svg")).toBeNull();
    }
  });

  it("a gap of 1 percentage point or less is float tolerance — the relation root still renders", () => {
    act(() =>
      root.render(<RailLinkOverlay {...overlayProps({ railStation: 49 })} />),
    );
    expect(host.querySelector(".rail-link-overlay")).not.toBeNull();
  });

  it("a bound panel left of a pinned rail is a connected relation face too", () => {
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({
            railStation: 60,
            targetRect: { left: 0, top: 0, width: 60, height: 100 },
            placementMode: "pin",
          })}
        />,
      ),
    );
    const relation = host.querySelector<HTMLElement>(".rail-link-overlay");
    expect(relation).not.toBeNull();
    expect(relation?.dataset.connected).toBe("true");
    expect(relation?.dataset.side).toBe("left");
  });

  it("a bound panel attached right of a pinned rail is a right composite border", () => {
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({
            railStation: 40,
            targetRect: { left: 40, top: 0, width: 30, height: 100 },
            placementMode: "pin",
          })}
        />,
      ),
    );
    const relation = host.querySelector<HTMLElement>(".rail-link-overlay");
    expect(relation?.dataset.connected).toBe("true");
    expect(relation?.dataset.side).toBe("right");
  });

  it("a bound panel apart from the pinned rail draws two independent active borders instead of joining them", () => {
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({
            railStation: 0,
            targetRect: { left: 50, top: 0, width: 50, height: 100 },
            placementMode: "pin",
          })}
        />,
      ),
    );
    const relation = host.querySelector<HTMLElement>(".rail-link-overlay");
    expect(relation).not.toBeNull();
    expect(relation?.dataset.connected).toBe("false");
    expect(relation?.dataset.placement).toBe("pin");
    expect(relation?.dataset.side).toBe("detached");
    expect(relation?.dataset.borderMode).toBe("independent");
    expect(relation?.dataset.pathCount).toBe("2");
    expect(relation?.dataset.relationId).toBe("rail-relation/c1/g2/v2");
    expect(relation?.querySelectorAll(".rail-link-independent")).toHaveLength(2);
    expect(relation?.querySelector(".rail-link-union")).toBeNull();
  });

  it("an absent binding with no visual path still keeps the public state root none/0", () => {
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({ targetRect: null })}
        />,
      ),
    );
    const relation = host.querySelector<HTMLElement>(".rail-link-overlay");
    expect(relation).not.toBeNull();
    expect(relation?.dataset).toMatchObject({
      connected: "false",
      side: "detached",
      borderMode: "none",
      pathCount: "0",
      relationId: "rail-relation/c1/none",
    });
    expect(relation?.querySelector("svg")).toBeNull();
  });

  it("moment: only a binding identity change flashes for 600ms and then turns off (fake timer)", () => {
    vi.useFakeTimers();
    useSettings.setState({ railRelation: "moment" });

    // A binding appearing (mount) is a "moment of change" too — flash.
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    const flash = () =>
      host.querySelector<HTMLElement>(".rail-link-overlay")!.dataset.flash;
    expect(flash()).toBe("true");

    act(() => vi.advanceTimersByTime(599));
    expect(flash()).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(flash()).toBe("false");

    // A re-render with the same identity does not re-ignite.
    act(() => root.render(<RailLinkOverlay {...overlayProps()} />));
    expect(flash()).toBe("false");

    // targetRect identity change → re-ignite.
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({ targetRect: { ...adjacentRect, width: 40 } })}
        />,
      ),
    );
    expect(flash()).toBe("true");
    act(() => vi.advanceTimersByTime(600));
    expect(flash()).toBe("false");

    // A boundViewId change is an identity change too → re-ignite.
    act(() =>
      root.render(
        <RailLinkOverlay
          {...overlayProps({
            boundViewId: "v3",
            targetRect: { ...adjacentRect, width: 40 },
          })}
        />,
      ),
    );
    expect(flash()).toBe("true");
  });
});

// jsdom does not compute CSS branches, so the style surface is gated directly (precedent: cssContract).
// These rules are experiment scaffolding too — delete the whole test once the 3 options are decided.
describe("railRelation mode CSS branches (style surface)", () => {
  const css = styleSurfaceRules();

  function decls(selector: string): string {
    const escaped = selector.replace(/[.[\]"=]/g, (c) => `\\${c}`);
    const match = css.match(
      new RegExp(`(?:^|,|\\})\\s*(?:[^,{}]+,\\s*)*${escaped}\\s*(?:,[^{}]+)?\\{([^}]*)\\}`),
    );
    expect(match, `the style surface must have a ${selector} rule`).not.toBeNull();
    return match![1];
  }

  it("tint: no stroke plus a low-density accent fill (no success color, no relation token)", () => {
    const d = decls(".rail-link-overlay.relation-tint .rail-link-shape");
    expect(d).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*5%,\s*transparent\)/);
    expect(d).toMatch(/stroke:\s*none/);
    expect(d).not.toMatch(/var\(--relation-stroke\)/);
  });

  it("a pinned non-adjacent relation is an independent active border with no fill, in every mode", () => {
    const d = decls(".rail-link-independent");
    expect(d).toMatch(/fill:\s*none\s*!important/);
    expect(d).toMatch(/stroke:\s*var\(--relation-stroke\)\s*!important/);
  });

  it("focus spotlight: only the inactive dims and the active stays clean (selection alone is explicit)", () => {
    // A filter on a content ancestor changes the DOM/canvas/WebGL compositing path, so it is banned. The overall
    // dimming is drawn by pane-local rectangles outside the content subtree.
    expect(css).not.toMatch(/\.(?:pane|tab-body)\[data-dim\][^{]*\{[^}]*filter\s*:/s);
    expect(decls(".focus-lighting-plane")).toMatch(/pointer-events:\s*none/);
    expect(decls(".focus-lighting-region")).toMatch(/position:\s*absolute/);
    expect(css).not.toMatch(/mask-type:\s*luminance/);
    expect(css).not.toMatch(/\.focus-lighting-mask\b/);
    // No rule branches on a stage name — with two branches they compete on specificity again.
    expect(css).not.toMatch(/\.(?:pane|tab-body)\[data-dim="/);
  });

  it("the railFill branch covers both fill paths (shape = natural adjacency, fill = replaced separate render)", () => {
    // Measured defect: the fill branch targeted only .rail-link-shape, so replacement-adjacency (option B,
    // .rail-link-fill) alone got the theme default fill — the cause of the "applies here, not there" mismatch.
    for (const mode of ["none", "faint"]) {
      const rule = css.match(
        new RegExp(
          `\\.rail-link-overlay\\.relation-stroke\\.fill-${mode} \\.rail-link-shape,\\s*\\.rail-link-overlay\\.relation-stroke\\.fill-${mode} \\.rail-link-fill\\s*\\{`,
        ),
      );
      expect(rule, `fill-${mode} covers both paths`).not.toBeNull();
    }
  });

  it("binding background switch: fill-none removes the background, fill-faint is a very light tint", () => {
    // User comparison experiment (① remove ② very faint) — only the fill inside stroke branches.
    const none = decls(".rail-link-overlay.relation-stroke.fill-none .rail-link-shape");
    expect(none).toMatch(/fill:\s*none/);
    const faint = decls(".rail-link-overlay.relation-stroke.fill-faint .rail-link-shape");
    expect(faint).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*1%,\s*transparent\)/);
  });

  it("seam CSS: a dotted line the same width as the relation stroke", () => {
    const d = decls(".rail-link-seam");
    expect(d).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(d).toMatch(/stroke-width:\s*var\(--relation-stroke-w\)/);
    expect(d).toMatch(/stroke-dasharray/);
  });

  it("option B edge dotted CSS: the detached right edge is dotted, the remaining open outline is solid with no fill", () => {
    const edge = decls(".rail-link-edge");
    expect(edge).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(edge).toMatch(/stroke-dasharray/);
    const rest = decls(".rail-link-rest");
    expect(rest).toMatch(/fill:\s*none/);
    expect(rest).toMatch(/stroke:\s*var\(--relation-stroke\)/);
  });

  it("no floating relation label — the binding name has one place, the host header (.projection-bound)", () => {
    // Relation display simplification (user decision): the "connected · name" badge is withdrawn. The sidebar
    // header owns the name (ProjectionSlots.frame.test verifies the display). Do not revive the label CSS.
    expect(css).not.toMatch(/rail-link-label/);
    expect(css).toMatch(/\.projection-bound\s*\{/);
  });

  it("moment: identical to tint at rest, the relation token only during the flash, fade-out on release", () => {
    const rest = decls(".rail-link-overlay.relation-moment .rail-link-shape");
    expect(rest).toMatch(/fill:\s*color-mix\(in srgb, var\(--acc\)\s*5%,\s*transparent\)/);
    expect(rest).toMatch(/transition:[^;]*stroke/);
    const flashing = decls(
      '.rail-link-overlay.relation-moment[data-flash="true"] .rail-link-shape',
    );
    expect(flashing).toMatch(/stroke:\s*var\(--relation-stroke\)/);
    expect(flashing).toMatch(/fill:\s*var\(--relation-fill\)/);
  });

  it("the glide animation applies only to actually moving elements (.flip-move) — no layer promotion for zero-delta elements", () => {
    // Real incident: selecting everything under the phase promoted even non-moving browser slots with animation +
    // will-change, so a re-raster on every phase made the DOM (the address bar) twitch.
    expect(css).toMatch(/\.rail-traveling \.tab-body\.flip-move/);
    expect(css).not.toMatch(/\.rail-traveling \.tab-body,/);
  });

  it("FLIP interpolates numerically in both directions with the same transform function signature", () => {
    // WebKit measured RED: individual `translate` interpolated the -160px direction, but in the +160px direction
    // only the progress advanced while the used rect stayed at the start and jumped at the end. Use the older
    // common primitive path of CSS Transforms and keep the start and end function signatures identical.
    const keyframes = css.match(/@keyframes rail-flip-x\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(keyframes).toMatch(/from\s*\{\s*transform:\s*translateX\(var\(--flip-x,\s*0px\)\)/);
    expect(keyframes).toMatch(/to\s*\{\s*transform:\s*translateX\(0px\)/);
    expect(keyframes).not.toMatch(/\btranslate\s*:/);
  });
});

describe("a measured size does not become a scale", () => {
  // Declarations only — counting comments too would flag the sentences that record the incident as violations and
  // make the rule erase its own evidence (this is the second time today for the same trap).
  const overlaySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "RailLinkOverlay.tsx"),
    "utf8",
  )
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("the SVG does not stretch through viewBox — a stale measurement distorts the drawing", () => {
    // Real incident 2026-08-02: the viewBox held the host size **arriving from observation** with
    // preserveAspectRatio="none". ResizeObserver arrives after paint, so the frame in which the host shrank or
    // grew was drawn at the old size and the whole drawing was squeezed or stretched by (new width / old width).
    // x=0 stays 0 under scaling, so only the outer edge held its place and only the inner edge was pushed in or
    // out — that is exactly what the user saw (in when pushing, out when collapsing, and then an exact return).
    //
    // The coordinates are already the element's CSS px. With no scale axis, a stale measurement can only be a
    // "wrong position", never a "distorted drawing" — the shape of the failure gets one step milder.
    expect(overlaySrc).not.toMatch(/viewBox=/);
    expect(overlaySrc).not.toMatch(/preserveAspectRatio/);
  });

  it("measure before drawing — observation handles only changes arriving from outside", () => {
    // There must be an effect that measures again after every render (before paint). When the value is the same
    // it is a no-op with no extra render; only a changed frame draws once more before paint.
    expect(overlaySrc).toMatch(
      /useLayoutEffect\(\(\) => \{[^}]*getBoundingClientRect\(\);\s*commitSize\([^)]*\);\s*\}\);/,
    );
  });
});
