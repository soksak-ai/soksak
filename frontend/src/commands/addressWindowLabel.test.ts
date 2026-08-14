import { describe, expect, it } from "vitest";

import { formatAddress, parseAddress } from "./address";

describe("addresses and the window label", () => {
  it("omits the window segment when there is no label", () => {
    // An empty label is not a label. Emitting `win//…` produces an address the
    // parser refuses, so the producer and the resolver disagree about a string
    // one of them just made — and the disagreement surfaces only as
    // "no such address" (measured 2026-08-15).
    expect(formatAddress({ window: "", chrome: "titlebar" })).toBe("chrome/titlebar");
  });

  it("keeps the window segment when there is a label", () => {
    expect(formatAddress({ window: "main", chrome: "titlebar" })).toBe("win/main/chrome/titlebar");
  });

  it("refuses an address with an empty window segment", () => {
    // The parser already refuses it; this pins that the two halves agree.
    expect(parseAddress("win//chrome/titlebar")).toHaveProperty("error");
  });

  it("round-trips every address it emits", () => {
    for (const parts of [
      { window: "main", chrome: "titlebar" },
      { chrome: "titlebar" },
      { window: "", chrome: "project/add" },
    ]) {
      const address = formatAddress(parts);
      expect(parseAddress(address), `parsing ${address}`).not.toHaveProperty("error");
    }
  });
});
