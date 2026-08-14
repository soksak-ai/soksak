// Command surface of the relation-surface three-option switch (railRelation) — the sok CLI must
// switch it immediately. settings.set uses the SETTING_KEYS whitelist plus per-key validation,
// so a single missing wiring (enum entry, switch case) yields INVALID_PARAMS or a false success
// that applies nothing.
// Temporary axis for the comparison experiment — removed together with the setting axis once
// the three options are decided.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
// Do not imitate the module with a hand-written list — when the contract gains an axis, what is
// absent from that list becomes undefined and the failure lands somewhere unrelated to this
// check (measured 2026-08-08: adding `setWindowZoom` to the contract killed this check on that
// missing name). Spread the real module (a neutral adapter under test) and replace the call site
// only.
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { serialize, useSettings } from "../state/settings";

registerCatalog();

beforeEach(() => {
  useSettings.setState({ railRelation: "stroke" });
});

describe("settings.windowZoom command surface", () => {
  it("get returns it (default 1), set clamps the value, and the appFontSize key is rejected", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { windowZoom: number }).windowZoom).toBe(1);
    const on = await execute("settings.set", { key: "windowZoom", value: 1.5 }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().windowZoom).toBe(1.5);
    const dead = await execute("settings.set", { key: "appFontSize", value: 14 }, {});
    expect(dead.ok).toBe(false);
    await execute("settings.set", { key: "windowZoom", value: 1 }, {});
  });
});

describe("settings.contentTabPosition command surface", () => {
  it("switches the DOM slot placement to top|left and rejects any other value", async () => {
    useSettings.setState({ contentTabPosition: "top" });

    const left = await execute(
      "settings.set",
      { key: "contentTabPosition", value: "left" },
      {},
    );
    expect(left.ok).toBe(true);
    expect(useSettings.getState().contentTabPosition).toBe("left");

    const bad = await execute(
      "settings.set",
      { key: "contentTabPosition", value: "bottom" },
      {},
    );
    expect(bad).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(useSettings.getState().contentTabPosition).toBe("left");

    await execute("settings.set", { key: "contentTabPosition", value: "top" }, {});
  });
});

describe("settings.focusDim command surface", () => {
  it("settings.get returns it (default false), set toggles it, a non-boolean is rejected", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { focusDim: boolean }).focusDim).toBe(true);
    const off = await execute("settings.set", { key: "focusDim", value: false }, {});
    expect(off.ok).toBe(true);
    expect(useSettings.getState().focusDim).toBe(false);
    const bad = await execute("settings.set", { key: "focusDim", value: "yes" }, {});
    expect(bad.ok).toBe(false);
    await execute("settings.set", { key: "focusDim", value: true }, {});
  });
});

describe("settings.railSeamStyle command surface", () => {
  it("get returns it (default edge), set takes seam|edge, anything else is rejected", async () => {
    const g = await execute("settings.get", {}, {});
    expect((g.data as { railSeamStyle: string }).railSeamStyle).toBe("edge");
    const on = await execute("settings.set", { key: "railSeamStyle", value: "edge" }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().railSeamStyle).toBe("edge");
    const bad = await execute("settings.set", { key: "railSeamStyle", value: "dotted" }, {});
    expect(bad.ok).toBe(false);
    await execute("settings.set", { key: "railSeamStyle", value: "edge" }, {});
  });
});

describe("settings.railFill command surface", () => {
  it("settings.get returns railFill (default none)", async () => {
    const result = await execute("settings.get", {}, {});
    expect(result.ok).toBe(true);
    expect((result.data as { railFill: string }).railFill).toBe("none");
  });

  it("settings.set switches between none|faint and rejects any other value", async () => {
    const on = await execute("settings.set", { key: "railFill", value: "faint" }, {});
    expect(on.ok).toBe(true);
    expect(useSettings.getState().railFill).toBe("faint");
    const off = await execute("settings.set", { key: "railFill", value: "none" }, {});
    expect(off.ok).toBe(true);
    expect(useSettings.getState().railFill).toBe("none");
    const bad = await execute("settings.set", { key: "railFill", value: "heavy" }, {});
    expect(bad.ok).toBe(false);
  });
});

describe("settings.railRelation command surface", () => {
  it("settings.get returns railRelation (default stroke)", async () => {
    const result = await execute("settings.get", {}, {});
    expect(result.ok).toBe(true);
    expect((result.data as { railRelation: string }).railRelation).toBe("stroke");
  });

  it("settings.set switches between the three options immediately", async () => {
    for (const mode of ["moment", "tint", "stroke"] as const) {
      const result = await execute(
        "settings.set",
        { key: "railRelation", value: mode },
        {},
      );
      expect(result.ok).toBe(true);
      expect(useSettings.getState().railRelation).toBe(mode);
    }
  });

  it("a value outside the three options is rejected with INVALID_PARAMS and is not applied", async () => {
    const result = await execute(
      "settings.set",
      { key: "railRelation", value: "badge" },
      {},
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(useSettings.getState().railRelation).toBe("stroke");
  });
});

describe("settings read surface", () => {
  it("every persisted setting is readable — a value that cannot be read cannot be diagnosed", async () => {
    // Real incident 2026-08-02: railLook was persisted but had no place to read it and no place
    // to change it. There was no way even to ask what condition the user's screen was in, and
    // the reproduction ended in "it does not happen". Writing may be narrow (a dedicated command
    // validates itself). Reading must not be narrow.
    const persisted = Object.keys(serialize(useSettings.getState()));
    const got = await execute("settings.get", {}, {});
    expect(got.ok).toBe(true);
    const data = got.data as Record<string, unknown>;
    const missing = persisted.filter((k) => !(k in data));
    expect(missing).toEqual([]);
  });
});
