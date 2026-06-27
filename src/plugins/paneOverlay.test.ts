// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { mountPaneOverlay } from "./paneOverlay";
import { registerPaneHost } from "./paneHostRegistry";

describe("mountPaneOverlay", () => {
  test("레지스트리에 등록된 host element 에 오버레이를 붙인다(셀렉터 없이)", () => {
    const host = document.createElement("div");
    const off = registerPaneHost("ov-a", host);
    const ov = document.createElement("div");

    mountPaneOverlay("ov-a", ov);

    expect(ov.parentElement).toBe(host);
    off();
  });

  test("dispose 가 오버레이를 제거한다", () => {
    const host = document.createElement("div");
    const off = registerPaneHost("ov-b", host);
    const ov = document.createElement("div");

    const dispose = mountPaneOverlay("ov-b", ov);
    expect(host.contains(ov)).toBe(true);

    dispose();
    expect(host.contains(ov)).toBe(false);
    off();
  });

  test("미등록 paneId 는 throw(침묵 실패 금지 — 셀렉터 null 의 약점을 구조적으로 제거)", () => {
    const ov = document.createElement("div");
    expect(() => mountPaneOverlay("ov-missing", ov)).toThrow();
  });
});
