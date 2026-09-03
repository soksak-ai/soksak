// View registry contract — register/unregister/version signal/placement filter.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getRegisteredView,
  useViewRegistry,
  viewsOnSurface,
  registeredViewIds,
  type PluginViewProvider,
} from "./viewRegistry";
import type { ContributedView } from "./spec";

const provider: PluginViewProvider = { restores: "none" as const, mount: () => {} };

function decl(id: string, surfaces: ContributedView["surfaces"]): ContributedView {
  return { id, title: id, icon: "P", surfaces, transparent: false, nativeSurface: false };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
});

describe("registeredViewIds — observing the actual side of declared≡actual", () => {
  it("view ids this plugin registered, in registration order — other plugins excluded", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider);
    useViewRegistry.getState().register("memo", decl("side", ["side"]), provider);
    useViewRegistry.getState().register("other", decl("x", ["tab"]), provider);
    expect(registeredViewIds("memo")).toEqual(["panel", "side"]);
    expect(registeredViewIds("none")).toEqual([]);
  });
});

describe("viewRegistry", () => {
  it("register → lookup by global key succeeds and version increments", () => {
    const v0 = useViewRegistry.getState().version;
    useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider);
    expect(getRegisteredView("memo.panel")?.pluginId).toBe("memo");
    expect(useViewRegistry.getState().version).toBe(v0 + 1);
  });

  it("duplicate registration is refused (§0-3 no silent collision)", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider);
    expect(() =>
      useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider),
    ).toThrow(/memo\.panel/);
  });

  it("unregister is idempotent and version increments only on a real change", () => {
    const remove = useViewRegistry
      .getState()
      .register("memo", decl("panel", ["side"]), provider);
    remove();
    expect(getRegisteredView("memo.panel")).toBeNull();
    const v = useViewRegistry.getState().version;
    remove(); // second unregister — no change
    expect(useViewRegistry.getState().version).toBe(v);
  });

  it("setViewBadge — set and clear, 0 normalized away, version unchanged (no view remount), badge cleared when the view is unregistered", () => {
    const st = useViewRegistry.getState();
    const remove = st.register("memo", decl("panel", ["side"]), provider);
    const v = useViewRegistry.getState().version;

    st.setViewBadge("memo.panel", 3);
    expect(useViewRegistry.getState().badges["memo.panel"]).toBe(3);
    // A badge change does not bump version (prevents a view remount).
    expect(useViewRegistry.getState().version).toBe(v);

    st.setViewBadge("memo.panel", "dot");
    expect(useViewRegistry.getState().badges["memo.panel"]).toBe("dot");
    // 0 normalizes to absent (key removed).
    st.setViewBadge("memo.panel", 0);
    expect(useViewRegistry.getState().badges["memo.panel"]).toBeUndefined();

    st.setViewBadge("memo.panel", 5);
    remove(); // view unregistered → badge cleared too.
    expect(useViewRegistry.getState().badges["memo.panel"]).toBeUndefined();
  });

  it("viewsOnSurface filters by declared surface", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider);
    useViewRegistry.getState().register("diff", decl("view", ["tab", "side"]), provider);
    expect(viewsOnSurface("side").map((x) => x.key)).toEqual([
      "memo.panel",
      "diff.view",
    ]);
    // The one declaring both surfaces is on both lists; the `side`-only one is on neither of the
    // tab's.
    expect(viewsOnSurface("tab").map((x) => x.key)).toEqual(["diff.view"]);
  });

  it("a surface nobody declared answers empty rather than everything", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["side"]), provider);
    expect(viewsOnSurface("tab")).toEqual([]);
  });
});
