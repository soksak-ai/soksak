// @vitest-environment jsdom
// Zoom intent routing (plan golden-swinging-lynx §1) — focus fixes the scope.
// DOM focus inside a view routes to that view's zoom (the view answers by its own convention). No view
// focus (frame selected = a chrome click puts focus on body) routes to whole-window zoom. No new state: DOM focus is the scope.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const zoomNative = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitPluginEvent: vi.fn(),
}));

// How the factor is applied to the screen is the framework's business — this test checks **when** it is applied.
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: zoomNative.invoke,
  framework: { setWindowZoom: zoomNative.invoke },
}));
vi.mock("../plugins/hooks", () => ({ emitPluginEvent: zoomNative.emitPluginEvent }));

import {
  applyWindowZoom,
  isPrimaryModifier,
  routeZoom,
  ZOOM_STEP,
  clampWindowZoom,
} from "./zoomIntent";

beforeEach(() => {
  zoomNative.invoke.mockReset();
  zoomNative.emitPluginEvent.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mountView(viewId: string): HTMLElement {
  const c = document.createElement("div");
  // Both names, same as production — the commands-layer check (viewContainerOf) still splits views by the old name.
  // A fixture ahead of production makes a passing test blind to the production defect.
  c.className = "tab-viewer plugin-view-container";
  c.dataset.viewAddr = "content/view/test.v";
  c.dataset.tabId = viewId;
  const input = document.createElement("textarea");
  c.appendChild(input);
  document.body.appendChild(c);
  input.focus();
  return c;
}

describe("routeZoom — focus sets the scope", () => {
  it("focus inside a view routes to that view and leaves window zoom unchanged", () => {
    mountView("v7");
    const view = vi.fn(() => true);
    const win = vi.fn();
    routeZoom("in", { zoomView: view, stepWindow: win });
    expect(view).toHaveBeenCalledWith("v7", "in");
    expect(win).not.toHaveBeenCalled();
  });

  it("no view focus (frame selection is body) routes to window zoom", () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const view = vi.fn(() => true);
    const win = vi.fn();
    routeZoom("out", { zoomView: view, stepWindow: win });
    expect(view).not.toHaveBeenCalled();
    expect(win).toHaveBeenCalledWith("out");
  });

  it("a focused view without zoom falls back to stepping the container font variable and does not leak into window zoom", () => {
    const c = mountView("v8");
    const view = vi.fn(() => false); // no hook
    const win = vi.fn();
    routeZoom("in", { zoomView: view, stepWindow: win });
    expect(win).not.toHaveBeenCalled();
    expect(c.style.getPropertyValue("--tab-font-size")).toBe("14px");
    routeZoom("reset", { zoomView: view, stepWindow: win });
    expect(c.style.getPropertyValue("--tab-font-size")).toBe("13px");
  });

  it("writes the old name with the same value, so zoom keeps working for a plugin view declared under the old name", () => {
    // Until the contract surface is migrated (the condition for removing the zoomIntent.ts header), both names always carry the same value.
    const c = mountView("v9");
    routeZoom("in", { zoomView: () => false, stepWindow: vi.fn() });
    expect(c.style.getPropertyValue("--view-font-size")).toBe("14px");
    expect(c.style.getPropertyValue("--view-font-size")).toBe(
      c.style.getPropertyValue("--tab-font-size"),
    );
  });

  it("a container that declares the old name only steps on from that value", () => {
    const c = mountView("v10");
    c.style.setProperty("--view-font-size", "20px");
    routeZoom("in", { zoomView: () => false, stepWindow: vi.fn() });
    expect(c.style.getPropertyValue("--tab-font-size")).toBe("21px");
  });
});

describe("window zoom numeric contract", () => {
  it("step 0.1, factor clamped to 0.5..2.0, reset 1.0", () => {
    expect(ZOOM_STEP).toBe(0.1);
    expect(clampWindowZoom(0.2)).toBe(0.5);
    expect(clampWindowZoom(3)).toBe(2);
    expect(clampWindowZoom(1.3000000001)).toBeCloseTo(1.3, 5);
  });

  it("primary modifier — mac is Cmd, everything else is Ctrl (one syntax across the three platforms)", () => {
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(true);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
  });
});

describe("window zoom application transaction", () => {
  it("emits no window.zoom to geometry consumers and does not complete before the native zoom ACK", async () => {
    let acknowledge!: () => void;
    zoomNative.invoke.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));

    const applied = applyWindowZoom(1.2) as unknown as Promise<void>;

    expect(zoomNative.invoke).toHaveBeenCalledWith(1.2);
    expect(
      zoomNative.emitPluginEvent,
      "window.zoom was emitted from intent time, before the native zoom/scale truth was applied",
    ).not.toHaveBeenCalled();
    expect(applied, "startup cannot await a void/fire-and-forget zoom application").toBeInstanceOf(Promise);

    acknowledge();
    await applied;
    expect(zoomNative.emitPluginEvent).toHaveBeenCalledWith("window.zoom", { factor: 1.2 });
  });
});
