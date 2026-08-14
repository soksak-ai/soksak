import { describe, expect, it } from "vitest";
import {
  BUILTIN_ICON_SET,
  getIconGlyph,
  useIconRegistry,
  validateIconSetData,
  registeredIconSetIds,
} from "./registry";
import { LUCIDE_ICONS } from "./sets/lucide";
import { ICON_NAMES } from "./types";

describe("iconRegistry", () => {
  it("registeredIconSetIds — the set ids this plugin registered (qualified to setId, lucide excluded)", () => {
    const fake = Object.fromEntries(
      ICON_NAMES.map((n) => [n, { v: "0 0 16 16", b: "<path d='M0 0'/>", f: "fill" }]),
    );
    useIconRegistry.getState().register({ id: "memo.dark", name: "Dark", data: fake as never });
    useIconRegistry.getState().register({ id: "memo.light", name: "Light", data: fake as never });
    useIconRegistry.getState().register({ id: "other.x", name: "X", data: fake as never });
    expect(registeredIconSetIds("memo")).toEqual(["dark", "light"]);
    expect(registeredIconSetIds("none")).toEqual([]);
    useIconRegistry.getState().unregister("memo.dark");
    useIconRegistry.getState().unregister("memo.light");
    useIconRegistry.getState().unregister("other.x");
  });

  it("the built-in lucide set provides every semantic name", () => {
    expect(validateIconSetData(LUCIDE_ICONS)).toBeNull();
    for (const n of ICON_NAMES) {
      const g = LUCIDE_ICONS[n];
      expect(g.v).toMatch(/^\d+ \d+ \d+ \d+$/);
      expect(g.b.length).toBeGreaterThan(0);
    }
  });

  it("a partial set is refused and names which glyph is missing", () => {
    const partial = { close: LUCIDE_ICONS.close };
    // Matched on the glyph name the message carries, not on its wording: the
    // sentence moves into the key table and the name does not.
    expect(validateIconSetData(partial)).toContain("add");
    expect(validateIconSetData(null)).not.toBeNull();
    expect(
      validateIconSetData({
        ...LUCIDE_ICONS,
        close: { v: "0 0 24 24", b: "<path/>", f: "wrong" },
      }),
    ).toContain("stroke|fill|both");
  });

  it("register, unregister and fallback: an unregistered or removed set falls back to lucide", () => {
    const st = useIconRegistry.getState();
    const fake = Object.fromEntries(
      ICON_NAMES.map((n) => [n, { v: "0 0 16 16", b: "<path d='M0 0'/>", f: "fill" }]),
    );
    st.register({ id: "test-set", name: "Test", data: fake as never });
    expect(getIconGlyph("test-set", "close").v).toBe("0 0 16 16");

    useIconRegistry.getState().unregister("test-set");
    expect(getIconGlyph("test-set", "close")).toBe(LUCIDE_ICONS.close);
    // An unregistered id falls back too.
    expect(getIconGlyph("no-such-set", "refresh")).toBe(LUCIDE_ICONS.refresh);
  });

  it("the built-in fallback set cannot be unregistered", () => {
    useIconRegistry.getState().unregister(BUILTIN_ICON_SET);
    expect(useIconRegistry.getState().sets[BUILTIN_ICON_SET]).toBeDefined();
  });
});
