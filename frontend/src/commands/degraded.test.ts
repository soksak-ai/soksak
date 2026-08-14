// Every response reports the degraded axes — a fact that needs a separate query is a fact
// nobody queries.
//
// Measured (2026-07-31): activity hub publishing was cut off while the app kept answering
// commands normally. Finding that out took two ledger queries and a comparison of the latest
// timestamps — manual work, not diagnosis. Whatever was asked, a limping core must be reported
// in that answer.
//
// The verdict needs "from when must it be present". Before boot declares wiring complete, a
// missing sink is not a defect (wiring is still in progress, or the harness never enabled that
// part). Without that declaration, a booting app and a broken app look the same.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

const SPEC = {
  description: "fixture",
  params: {},
  returns: "void",
  message: () => "ok",
  handler: () => ({}),
};

describe("a response names the axis that is degraded", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("reports nothing before the wiring is declared complete", async () => {
    const reg = await import("./registry");
    reg.register("d.fixture", SPEC as never);
    const r = await reg.execute("d.fixture", {}, {});
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  it("reports a missing trace sink once the wiring is declared complete", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    reg.register("d.fixture", SPEC as never);
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // Execution succeeds — dead observation does not block behavior.
    expect(r.ok).toBe(true);
    // But it is not silent.
    expect(r.degraded?.some((d) => d.startsWith("commands:"))).toBe(true);
  });

  it("reports zero hub publish attempts as a fact of its own", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    reg.register("d.fixture", SPEC as never);
    obs.setCommandTraceSink(() => {});
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // Zero attempts is unconfirmed, not "healthy" — it separates a window with no wiring at all from a working one.
    expect(r.degraded?.some((d) => d.startsWith("activity:"))).toBe(true);
  });

  it("names no axis when the wiring is intact", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    const health = await import("../state/activityHealth");
    reg.register("d.fixture", SPEC as never);
    obs.setCommandTraceSink(() => {});
    health.notePublish(true, 1000);
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // Oracle survival — an axis that shows up on healthy wiring too makes this check separate nothing.
    expect(r.degraded).toBeUndefined();
  });
});
