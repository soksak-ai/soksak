// Module-global state must not disappear — the dev hot-swap boundary.
//
// Measured(2026-07-31): the core command catalog vanished entirely. The window was alive and plugin
// commands answered, but `ui.*`, `state.*` and `window.*` all returned UNKNOWN_COMMAND. To the user it
// looked like "the tab + creates nothing" — + is hidden when 0 programs are registered.
//
// The cause: registration is a **side effect of module evaluation**. The registry(Map) and the site that
// fills it(the started flag in executor) are in different modules and are swapped separately. Swapping only
// the Map produces a new empty Map, and the filling side still has its started flag set, so it does not fill
// again — the Map stays empty forever.
//
// Here that swap is reproduced by resetting the module cache. Evaluating the same module twice must preserve
// what was stored before.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("moduleState — it survives a module swap", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("returns the same value when the module is evaluated again", async () => {
    const first = await import("./moduleState");
    const boxA = first.moduleState("t/box", () => new Map<string, number>());
    boxA.set("x", 1);

    // Equivalent of a dev hot-swap — the module instance is evaluated anew.
    vi.resetModules();
    const second = await import("./moduleState");
    expect(second).not.toBe(first); // oracle liveness: was it really evaluated again
    const boxB = second.moduleState("t/box", () => new Map<string, number>());

    expect(boxB).toBe(boxA);
    expect(boxB.get("x")).toBe(1);
  });

  it("keeps different names apart", async () => {
    const m = await import("./moduleState");
    const a = m.moduleState("t/a", () => new Map<string, number>());
    const b = m.moduleState("t/b", () => new Map<string, number>());
    a.set("k", 1);
    expect(b.size).toBe(0);
  });
});

// Two different sites using the same name must **fail loudly** — silently handing back another site's value
// leaves that state running without its own fields, and the silence raises no error.
// Measured(2026-07-31): in one file two states shared `#state`, so the later one got the earlier one.
describe("moduleState — a name collision cannot be silent", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("refuses a different shape under the same name", async () => {
    const m = await import("./moduleState");
    m.moduleState("t/clash", () => ({ a: 1 }));
    expect(() => m.moduleState("t/clash", () => ({ b: 2 }))).toThrow(/t\/clash/);
  });

  it("accepts re-evaluation at the same site — a new make function of the same shape", async () => {
    const m = await import("./moduleState");
    const first = m.moduleState("t/same", () => ({ a: 1 }));
    first.a = 9;
    const again = m.moduleState("t/same", () => ({ a: 1 }));
    expect(again).toBe(first);
    expect(again.a).toBe(9);
  });
});
