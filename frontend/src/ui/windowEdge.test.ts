import { describe, expect, it } from "vitest";

import { BORDER_RULES } from "./borderContract";

/** The rail owns its complete perimeter at every station.  It is inset from
 * the neighbouring pane, so the same one-pixel outline is visible at both
 * outer and inner sides instead of relying on an OS frame or delegation. */
describe("window edge contract", () => {
  it("uses one complete perimeter rule", () => {
    const rail = BORDER_RULES.find((r) => r.id === "rail-perimeter");
    expect(rail).toBeDefined();
    expect(rail?.edges).toEqual({ left: "bd", right: "bd" });
  });
});
