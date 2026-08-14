import { describe, expect, it } from "vitest";

import { moduleState } from "./moduleState";

describe("module state across re-evaluation", () => {
  it("keeps a class-backed state when the module is evaluated again", () => {
    // A re-evaluated module defines its class afresh, so the two constructors
    // are different objects even though the shape is identical. Comparing
    // constructor identity reads that as a name collision and throws, which
    // turns a reload into a crash — measured on the command registry, where
    // filling it a second time reported
    // "components/PluginViewHost#overlayLedger — a differently shaped state".
    const first = () => {
      class Ledger {
        entries: string[] = [];
      }
      return moduleState("test#ledger.reeval", () => new Ledger());
    };
    const second = () => {
      class Ledger {
        entries: string[] = [];
      }
      return moduleState("test#ledger.reeval", () => new Ledger());
    };

    const one = first();
    one.entries.push("kept");

    expect(() => second()).not.toThrow();
    expect(second().entries).toEqual(["kept"]);
  });

  it("still refuses a genuinely different shape under one name", () => {
    // The rule this protects stays: two places sharing a name silently hand one
    // the other's object, and the fields it expects are simply absent.
    moduleState("test#shape.clash", () => ({ a: 1 }));

    expect(() => moduleState("test#shape.clash", () => ({ b: 2 }))).toThrow(/test#shape\.clash/);
  });

  it("still refuses a different class under one name", () => {
    class Ledger {
      entries: string[] = [];
    }
    class Registry {
      names: string[] = [];
    }
    moduleState("test#class.clash", () => new Ledger());

    expect(() => moduleState("test#class.clash", () => new Registry())).toThrow(/test#class\.clash/);
  });
});
