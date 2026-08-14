import { describe, expect, it, vi } from "vitest";

// jsdom localStorage is a dead stub in this environment, so replace it with a Map-based mock (precedent: pluginSettings.test).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { useSettings } from "./settings";

// Tab close confirm policy (R6): warn = confirm when risky (default), off = close unconditionally.
describe("settings.tabCloseConfirm", () => {
  it("the default is warn — confirm when risky", () => {
    expect(useSettings.getState().tabCloseConfirm).toBe("warn");
  });

  it("setTabCloseConfirm switches to off (close unconditionally) and back", () => {
    useSettings.getState().setTabCloseConfirm("off");
    expect(useSettings.getState().tabCloseConfirm).toBe("off");
    useSettings.getState().setTabCloseConfirm("warn");
    expect(useSettings.getState().tabCloseConfirm).toBe("warn");
  });
});

// Focus spotlight (settled setting, default on) — sink everything, keep only the selection clear.
describe("settings.focusDim", () => {
  it("the default is on — the user settled on the current behavior", () => {
    expect(useSettings.getState().focusDim).toBe(true);
  });
  it("setFocusDim turns it on and off", () => {
    useSettings.getState().setFocusDim(true);
    expect(useSettings.getState().focusDim).toBe(true);
    useSettings.getState().setFocusDim(false);
    expect(useSettings.getState().focusDim).toBe(false);
  });
});

// Window zoom (plan golden-swinging-lynx) — the value of ⌘± when the frame is selected. Replaces appFontSize (dead axis).
describe("settings.windowZoom", () => {
  it("default 1.0, clamped to 0.5..2.0", () => {
    expect(useSettings.getState().windowZoom).toBe(1);
    useSettings.getState().setWindowZoom(9);
    expect(useSettings.getState().windowZoom).toBe(2);
    useSettings.getState().setWindowZoom(0.1);
    expect(useSettings.getState().windowZoom).toBe(0.5);
    useSettings.getState().setWindowZoom(1);
  });

  it("the appFontSize axis is gone — window zoom and view zoom replace it", () => {
    expect("appFontSize" in useSettings.getState()).toBe(false);
  });
});

// Swap-adjacency display — settled setting (default edge = user choice, seam kept as an option).
describe("settings.railSeamStyle", () => {
  it("the default is edge — a dashed outer edge, the user choice", () => {
    expect(useSettings.getState().railSeamStyle).toBe("edge");
  });
  it("setRailSeamStyle switches between seam and edge", () => {
    useSettings.getState().setRailSeamStyle("edge");
    expect(useSettings.getState().railSeamStyle).toBe("edge");
    useSettings.getState().setRailSeamStyle("seam");
    expect(useSettings.getState().railSeamStyle).toBe("seam");
  });
});

// Linked panel fill (settled setting, default none — user choice).
describe("settings.railFill", () => {
  it("the default is none — no fill, the user choice", () => {
    expect(useSettings.getState().railFill).toBe("none");
  });

  it("setRailFill switches between none and faint and back", () => {
    useSettings.getState().setRailFill("faint");
    expect(useSettings.getState().railFill).toBe("faint");
    useSettings.getState().setRailFill("none");
    expect(useSettings.getState().railFill).toBe("none");
  });
});

// Relation plane rendering (settled setting) — stroke is the default.
describe("settings.railRelation", () => {
  it("the default is stroke — border and label, the user choice", () => {
    expect(useSettings.getState().railRelation).toBe("stroke");
  });

  it("setRailRelation switches among the three options (tint, moment, stroke) and back", () => {
    useSettings.getState().setRailRelation("moment");
    expect(useSettings.getState().railRelation).toBe("moment");
    useSettings.getState().setRailRelation("stroke");
    expect(useSettings.getState().railRelation).toBe("stroke");
    useSettings.getState().setRailRelation("tint");
    expect(useSettings.getState().railRelation).toBe("tint");
  });
});
