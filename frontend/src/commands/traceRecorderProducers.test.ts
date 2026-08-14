// Whether the observation device perturbed what it observed must be decidable.
//
// Over a 340ms glide the 8ms recorder ticks 42 times and calls getBoundingClientRect on every target
// node per tick (appendMultiDomTraceSample in catalogDom.ts). That many forced layouts can delay
// rAF — in the measurement the presentation column was empty for 3 epochs while the 8ms samples over
// that span arrived at exactly 8ms intervals. Reading that correlation as causation needs a control
// run with the recorder off over the same transaction, which needs it to be switchable off.
//
// Defaults are unchanged — this axis only makes the control run possible; it does not change the
// contract.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = () => readFileSync(resolve(import.meta.dirname, "catalogDom.ts"), "utf8");

describe("presentation column producer selection", () => {
  it("trace start takes which producers to enable", () => {
    const start = source().split('register("ui.trace.multi.start"')[1]?.slice(0, 1400) ?? "";
    expect(start).toContain("producers");
  });

  it("disabling the recorder installs no tick — the condition is at the install site, not inside the tick", () => {
    const text = source();
    const install = text.split("session.intervalProducer = setInterval(")[0].slice(-400);
    expect(install).toContain("intervalEnabled");
  });

  it("the receipt states what was enabled and disabled — two runs must be distinguishable afterwards", () => {
    const close = source().split('register("ui.trace.multi.close"')[1]?.slice(0, 1400) ?? "";
    expect(close).toContain("producersEnabled");
  });
});
