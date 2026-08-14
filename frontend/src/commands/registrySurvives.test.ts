// The command registry cannot disappear — what worked must not stop working at random.
//
// Measured 2026-07-31: the window was up and plugin commands answered, but `ui.*`, `state.*` and
// `window.*` were all UNKNOWN_COMMAND. To the user it showed as "the + on the tab does not create"
// — + is a button that disappears when 0 programs are registered, so the defect was disguised as
// "the button is missing".
//
// The cause is that registration is a side effect of module evaluation. The registry Map and the
// place that fills it (the started flag in executor) are in different modules and **swap
// separately**. When only the Map is swapped it becomes a new empty Map, and the filling side keeps
// its already-run flag and never refills — empty forever.
//
// Both directions are pinned: the registry survives being swapped alone, and the filling side
// swapped alone does not produce two copies.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("command registry — a hot swap does not drop registrations", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("registrations remain after only the registry module is re-evaluated", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const before = await import("./registry");
    const names = before.catalogJson().map((c) => c.name);
    // Oracle liveness — if it is empty from the start this check judges nothing ("the two faces of 0").
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("state.commands");

    // Equivalent to a dev hot swap: only the registry module is re-evaluated (the filling side still holds its already-run flag).
    vi.resetModules();
    const after = await import("./registry");
    expect(after).not.toBe(before); // proves the module really was re-evaluated

    expect(after.getSpec("state.commands")).toBeDefined();
    expect(after.catalogJson().length).toBe(names.length);
  });

  it("re-running the filling side does not duplicate registrations", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const n = reg.catalogJson().length;
    expect(n).toBeGreaterThan(0);

    // Only the filling side swapped — started returns to false and it tries to fill again.
    vi.resetModules();
    const exec2 = await import("./executor");
    exec2.startExecutor();

    const reg2 = await import("./registry");
    // register blocks duplicate registration with an error. That error must not break boot, and the count must stay the same.
    expect(reg2.catalogJson().length).toBe(n);
  });
});
