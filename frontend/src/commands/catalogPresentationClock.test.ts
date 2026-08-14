import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PRESENTATION_CLOCK,
  __resetPresentationClockForTest,
} from "../lib/presentationClock";
import { registerPresentationClockCatalog } from "./catalogPresentationClock";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  __resetPresentationClockForTest();
  let timeOrigin = 1_000;
  let now = 20;
  vi.stubGlobal("performance", {
    get timeOrigin() { return timeOrigin; },
    now: () => now,
  });
  registerPresentationClockCatalog();
  timeOrigin = -4_000;
  now = 35;
});

afterEach(() => {
  unregister("presentation.clock.acknowledge");
  vi.unstubAllGlobals();
  __resetPresentationClockForTest();
});

it("returns one core-owned control-clock acknowledgement and echoes caller identity", async () => {
  const receipt = await execute(
    "presentation.clock.acknowledge",
    { traceId: "gate-b05/left" },
    {},
  );
  expect(receipt).toMatchObject({
    ok: true,
    data: {
      traceId: "gate-b05/left",
      clock: PRESENTATION_CLOCK,
      atUnixMs: 1_035,
    },
  });
  expect(getSpec("presentation.clock.acknowledge")?.returns).toContain("atUnixMs");
});

it("rejects an empty correlation identity", async () => {
  const receipt = await execute("presentation.clock.acknowledge", { traceId: "  " }, {});
  expect(receipt).toMatchObject({ ok: false });
});
