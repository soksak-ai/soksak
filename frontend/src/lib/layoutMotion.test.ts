// @vitest-environment jsdom
// Layout motion signal (single source) — divider drag, rail travel, and FLIP can overlap on the same fact
// ("a surface is moving"), so a refcount pairs begin with end. Consumers (browser freeze-frame, CEF relay)
// are notified on edges only. Measured basis: during travel the DOM slides but the native child jumps at
// the end (video f062 — the file tree slides over Google).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLayoutMotion,
  endLayoutMotion,
  onLayoutMotion,
  __resetLayoutMotionForTest,
} from "./layoutMotion";

const emits: boolean[] = [];
const payloads: { active: boolean; kinds: string[] }[] = [];
vi.mock("../plugins/hooks", () => ({
  emitPluginEvent: (_e: string, p: { active: boolean; kinds: string[] }) => {
    emits.push(p.active);
    payloads.push(p);
  },
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: async () => {} }));

afterEach(() => {
  emits.length = 0;
  payloads.length = 0;
  __resetLayoutMotionForTest();
});

describe("layoutMotion — refcount edge notification", () => {
  it("true only on the first begin, false only on the last end", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("move"); // overlap, two runs
    endLayoutMotion("move");
    endLayoutMotion("move");
    expect(emits).toEqual([true, false]);
  });

  it("ignores a surplus end, the count never goes negative", () => {
    endLayoutMotion("move");
    beginLayoutMotion("move");
    endLayoutMotion("move");
    expect(emits).toEqual([true, false]);
  });

  it("a local listener receives the same edges and receives none after unsubscribing", () => {
    const seen: boolean[] = [];
    const off = onLayoutMotion((a) => seen.push(a));
    beginLayoutMotion("move");
    beginLayoutMotion("move");
    endLayoutMotion("move");
    endLayoutMotion("move");
    expect(seen).toEqual([true, false]);
    off();
    beginLayoutMotion("move");
    expect(seen).toEqual([true, false]);
  });
});

describe("layoutMotion — kind axis (move|resize)", () => {
  it("the payload kinds list the active kinds", () => {
    beginLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("re-emits active:true when the kind set changes while active, the basis for re-evaluating freeze", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("resize"); // divider intervenes mid-run
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move", "resize"] });
    endLayoutMotion("resize");
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("an overlap of the same kind does not re-emit, duplicates are suppressed", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("move");
    expect(payloads.length).toBe(1);
  });

  it("ignores a surplus end per kind", () => {
    beginLayoutMotion("move");
    endLayoutMotion("resize"); // resize never started
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
  });
});

describe("layoutMotion — kinds passed to local listeners", () => {
  it("a listener receives (active, kinds) and is notified of a kind change while active", () => {
    const seen: [boolean, string[]][] = [];
    onLayoutMotion((a, k) => seen.push([a, k]));
    beginLayoutMotion("move");
    beginLayoutMotion("resize");
    endLayoutMotion("resize");
    endLayoutMotion("move");
    expect(seen).toEqual([
      [true, ["move"]],
      [true, ["move", "resize"]],
      [true, ["move"]],
      [false, []],
    ]);
  });
});

describe("layoutMotion — the channel publishes facts only, scope goes to local consumers", () => {
  it("the plugin channel omits the scope — content-view.veiled notifies the exact targets", () => {
    beginLayoutMotion("move", ["vA"]);
    expect(payloads[payloads.length - 1]).toEqual({
      active: true,
      kinds: ["move"],
    });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("re-notifies local consumers when the scope changes — the duplicate-suppression key includes the scope", () => {
    // If the key ignores the scope, the start of the second scope phase is swallowed and the surface that
    // actually moves is never notified of its phase (real incident). Same active and kinds, different scope, different fact.
    const seen: (string[] | null)[] = [];
    const off = onLayoutMotion((_active, _kinds, scope) =>
      seen.push(scope ? [...scope].sort() : null),
    );
    beginLayoutMotion("move", ["vA"]);
    beginLayoutMotion("move", ["vB"]);
    endLayoutMotion("move");
    endLayoutMotion("move");
    off();
    // The scope of the end notification has no meaning (0 active phases) — consumers thaw everything on active:false.
    expect(seen).toEqual([["vA"], ["vA", "vB"], ["vA"], []]);
  });
});
