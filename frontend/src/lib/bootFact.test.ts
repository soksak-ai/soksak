// A boot step records which window it came from — with two windows, a ledger without that field stops
// the diagnosis.
//
// Measured 2026-08-01: diagnosing a blank window, two `painted` steps existed and neither included the
// window. That left only "both reported painted", with no way to separate the false one.
import { describe, it, expect, vi } from "vitest";
import { bootFactPayload } from "./bootFact";

vi.mock("./webviewLabels", () => ({ currentWindowLabel: () => "w-test" }));

describe("boot.step payload", () => {
  it("includes the window label", () => {
    expect(bootFactPayload("painted").window).toBe("w-test");
  });

  it("includes step and message together — the human line and the machine field are the same fact", () => {
    const p = bootFactPayload("boot:done");
    expect(p.step).toBe("boot:done");
    expect(p.message).toBe("· boot boot:done");
  });

  it("includes step-specific facts alongside", () => {
    expect(bootFactPayload("plugin-activate", { ms: 120 }).ms).toBe(120);
  });

  it("extra cannot overwrite step or window", () => {
    // If overwrite were allowed, the same field name would mean something different at each publish site.
    const p = bootFactPayload("real", { step: "fake", window: "w-fake" });
    expect(p.step).toBe("real");
    expect(p.window).toBe("w-test");
  });
});
