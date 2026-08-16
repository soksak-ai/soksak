import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CHROME_BANDS } from "./chromeBands";
import { HEADER_PX } from "../components/GroupArea";
import { SIDEBAR_HEADER_PX } from "../components/SectionSetHost";

// Within one window the header has one height and the footer has one height. When the sidebar and
// the content use different values, the bands of the two regions run side by side one pixel apart,
// and that mismatch looks different per theme.
//
// Measured 2026-08-15: content header 33px, sidebar header 30px, content footer 24px, no sidebar footer.
describe("chrome band contract", () => {
  it("the header is the same height everywhere", () => {
    expect(HEADER_PX).toBe(CHROME_BANDS.header);
    expect(SIDEBAR_HEADER_PX).toBe(CHROME_BANDS.header);
  });

  it("the footer is the same height everywhere", () => {
    expect(CHROME_BANDS.footer).toBeGreaterThan(0);
  });

  it("the no-theme fallback and the JS constant do not diverge", () => {
    // The theme owns the values (:root comment in App.css). The fallback used when there is no theme
    // is the answer for that absence, and JS needs the same value for hit testing — when the two
    // diverge, the visible band and the band a click hits are at different places. Measured
    // 2026-08-15: fallback 33 / sidebar constant 30.
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    const fallback = (name: string): number => {
      const found = css.match(new RegExp(`--${name}:\\s*(\\d+)px`));
      if (!found) throw new Error(`App.css has no --${name} fallback`);
      return Number(found[1]);
    };

    expect(fallback("header-h")).toBe(CHROME_BANDS.header);
    expect(fallback("status-h")).toBe(CHROME_BANDS.footer);
  });
});
