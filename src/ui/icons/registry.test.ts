import { describe, expect, it } from "vitest";
import {
  BUILTIN_ICON_SET,
  getIconGlyph,
  useIconRegistry,
  validateIconSetData,
} from "./registry";
import { LUCIDE_ICONS } from "./sets/lucide";
import { ICON_NAMES } from "./types";

describe("iconRegistry", () => {
  it("내장 lucide 는 전 시맨틱 이름을 제공한다", () => {
    expect(validateIconSetData(LUCIDE_ICONS)).toBeNull();
    for (const n of ICON_NAMES) {
      const g = LUCIDE_ICONS[n];
      expect(g.v).toMatch(/^\d+ \d+ \d+ \d+$/);
      expect(g.b.length).toBeGreaterThan(0);
    }
  });

  it("부분 셋은 어느 이름이 비었는지 알려주며 거부된다", () => {
    const partial = { close: LUCIDE_ICONS.close };
    expect(validateIconSetData(partial)).toContain("아이콘 누락");
    expect(validateIconSetData(null)).not.toBeNull();
    expect(
      validateIconSetData({
        ...LUCIDE_ICONS,
        close: { v: "0 0 24 24", b: "<path/>", f: "wrong" },
      }),
    ).toContain("stroke|fill|both");
  });

  it("등록/해제와 폴백: 미등록 셋·해제된 셋은 lucide 로 폴백한다", () => {
    const st = useIconRegistry.getState();
    const fake = Object.fromEntries(
      ICON_NAMES.map((n) => [n, { v: "0 0 16 16", b: "<path d='M0 0'/>", f: "fill" }]),
    );
    st.register({ id: "test-set", name: "Test", data: fake as never });
    expect(getIconGlyph("test-set", "close").v).toBe("0 0 16 16");

    useIconRegistry.getState().unregister("test-set");
    expect(getIconGlyph("test-set", "close")).toBe(LUCIDE_ICONS.close);
    // 미등록 id 도 폴백.
    expect(getIconGlyph("no-such-set", "refresh")).toBe(LUCIDE_ICONS.refresh);
  });

  it("내장 폴백 셋은 해제할 수 없다", () => {
    useIconRegistry.getState().unregister(BUILTIN_ICON_SET);
    expect(useIconRegistry.getState().sets[BUILTIN_ICON_SET]).toBeDefined();
  });
});
