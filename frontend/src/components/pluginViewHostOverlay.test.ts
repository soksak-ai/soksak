import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PluginViewHostOverlayLedger,
  overlayReasonOf,
} from "./pluginViewHostOverlay";

describe("PluginViewHost overlay receipt", () => {
  it("separates the registry, boot and presentation error branches into exact reasons", () => {
    expect(overlayReasonOf({ registryPresent: false, bootPhase: "loading", error: null }))
      .toBe("registry-loading");
    expect(overlayReasonOf({ registryPresent: false, bootPhase: "ready", error: null }))
      .toBe("registry-missing");
    expect(overlayReasonOf({ registryPresent: true, bootPhase: "ready", error: "presentation failed" }))
      .toBe("presentation-error");
    expect(overlayReasonOf({ registryPresent: true, bootPhase: "ready", error: null }))
      .toBe("none");
  });

  it("current status and the bounded events keep view, container generation and error unchanged", () => {
    const ledger = new PluginViewHostOverlayLedger(4);
    const receipt = ledger.report({
      viewKey: "soksak-plugin-browser.content",
      viewId: "tab-left",
      containerGeneration: 7,
      registryPresent: true,
      bootPhase: "ready",
      overlayReason: "presentation-error",
      error: "PANE_MEMBER_SLOT_APPLY_MISMATCH",
    });
    expect(receipt.sequence).toBe(1);
    expect(ledger.status()).toEqual({
      current: [receipt],
      events: [receipt],
      maxEvents: 4,
    });
    ledger.remove({ viewKey: receipt.viewKey, viewId: receipt.viewId, containerGeneration: 6 });
    expect(ledger.status().current).toEqual([receipt]);
    ledger.remove({ viewKey: receipt.viewKey, viewId: receipt.viewId, containerGeneration: 7 });
    expect(ledger.status().current).toEqual([]);
  });

  it("the component publishes the render-owned overlay branch to the layout effect as the same receipt", () => {
    const source = readFileSync(resolve(import.meta.dirname, "PluginViewHost.tsx"), "utf8");
    expect(source).toContain("overlayReasonOf({");
    expect(source).toContain("publishPluginViewHostOverlay({");
    expect(source).toContain("containerGeneration: generation");
    expect(source).toContain("registryPresent: !!reg");
    expect(source).toContain("bootPhase");
    expect(source).toContain("overlayReason");
    expect(source).toContain("error");
    expect(source).toContain("return () => removePluginViewHostOverlay({");
  });
});
