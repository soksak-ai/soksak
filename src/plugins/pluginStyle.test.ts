// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { injectPluginStyle } from "./pluginStyle";

afterEach(() => {
  document.head.replaceChildren();
});

describe("injectPluginStyle", () => {
  test("head 에 key 태그된 <style> 을 만들고 css 를 넣는다", () => {
    injectPluginStyle(document, "p1", ".a{color:red}");
    const el = document.head.querySelector('style[data-plugin-style="p1"]');
    expect(el).toBeTruthy();
    expect(el!.textContent).toBe(".a{color:red}");
  });

  test("같은 key 재주입 = 같은 <style> 재사용(중복 생성 없이 css 교체)", () => {
    injectPluginStyle(document, "p1", ".a{color:red}");
    injectPluginStyle(document, "p1", ".a{color:blue}");
    const els = document.head.querySelectorAll('style[data-plugin-style="p1"]');
    expect(els.length).toBe(1);
    expect(els[0].textContent).toBe(".a{color:blue}");
  });

  test("다른 key = 별도 <style>", () => {
    injectPluginStyle(document, "p1", ".a{}");
    injectPluginStyle(document, "p2", ".b{}");
    expect(
      document.head.querySelectorAll("style[data-plugin-style]").length,
    ).toBe(2);
  });

  test("dispose 가 <style> 을 제거한다", () => {
    const off = injectPluginStyle(document, "p1", ".a{}");
    expect(
      document.head.querySelector('style[data-plugin-style="p1"]'),
    ).toBeTruthy();
    off();
    expect(
      document.head.querySelector('style[data-plugin-style="p1"]'),
    ).toBeNull();
  });
});
