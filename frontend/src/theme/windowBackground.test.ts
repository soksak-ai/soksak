// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES } from "./builtin";
import { applyThemeToDom, parseTheme, setWindowBackgroundSink } from "./engine";

function theme(index: number) {
  const { theme } = parseTheme(BUILTIN_THEMES[index], "builtin");
  if (!theme) throw new Error("builtin theme did not parse");
  return theme;
}

describe("window background follows the theme", () => {
  it("publishes the background colour when a theme is applied", () => {
    // The document paints transparent, so unpainted regions show the window's
    // own colour. A window left on a build-time constant disagrees with the
    // theme at every edge — measured 2026-08-15: the window stayed near-black
    // while a light theme was active, and the translucent backdrop showed the
    // desktop through it.
    const seen: string[] = [];
    setWindowBackgroundSink((colour) => seen.push(colour));

    const midnight = theme(1);
    applyThemeToDom(midnight, midnight.defaultMode);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(midnight.colors.bg);
  });

  it("publishes the other mode's background when the mode flips", () => {
    const seen: string[] = [];
    setWindowBackgroundSink((colour) => seen.push(colour));

    const cupertino = theme(0);
    applyThemeToDom(cupertino, "light");
    applyThemeToDom(cupertino, "dark");

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("is harmless where no window exists", () => {
    // Headless runs and tests have no window to colour. Absence is not failure.
    setWindowBackgroundSink(null);
    const midnight = theme(1);

    expect(() => applyThemeToDom(midnight, midnight.defaultMode)).not.toThrow();
  });
});
