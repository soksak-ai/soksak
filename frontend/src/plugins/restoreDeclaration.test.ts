// Every view declares what its restore needs, and a view that declares nothing is refused.
import { describe, expect, it } from "vitest";

import { restoreKindOf, RESTORE_KINDS } from "./restoreDeclaration";
import type { PluginViewProvider } from "./viewRegistry";

// A view that only draws, with no declaration: what this file is about is the declaration, so it
// is added per case rather than baked in here.
const drawing = { mount: () => {} };

describe("a view's restore declaration", () => {
  it("names the three kinds and nothing else", () => {
    // The set is closed here rather than at each reader: a fourth kind means the readers that
    // branch on it are incomplete, and a string type hides that.
    expect([...RESTORE_KINDS]).toEqual(["none", "view", "session"]);
  });

  it("is read back from the provider", () => {
    for (const kind of RESTORE_KINDS) {
      expect(restoreKindOf({ ...drawing, restores: kind } as PluginViewProvider)).toBe(kind);
    }
  });

  it("refuses a view that declares nothing", () => {
    // An absent record means one thing for a view that keeps nothing and another for a view that
    // failed to read what it kept. Without the declaration the core cannot judge either.
    //
    // The refusal is a sentence from the bundle, so the reader's language decides its words. What
    // is asserted is that there is one and that it names the three kinds a caller has to pick from.
    expect(() => restoreKindOf(drawing as unknown as PluginViewProvider)).toThrow(
      /none, view, session/,
    );
  });

  it("refuses a kind that is not one of the three", () => {
    expect(() =>
      restoreKindOf({ ...drawing, restores: "everything" } as unknown as PluginViewProvider),
    ).toThrow(/none, view, session/);
  });
});
