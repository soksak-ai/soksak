import { describe, expect, it } from "vitest";

import { createViewRegistry } from "./views";

const noopProvider = () => () => {};

describe("view registry", () => {
  it("resolves a provider the core has never heard of", () => {
    const views = createViewRegistry();
    views.register("acme.inspector", noopProvider);

    expect(views.resolve("acme.inspector")).toBe(noopProvider);
  });

  it("answers absence with null rather than throwing", () => {
    // A missing view is a legitimate state — a plugin can be disabled while its
    // leaf still exists. Throwing here would take the whole tree down with it.
    expect(createViewRegistry().resolve("acme.missing")).toBeNull();
  });

  it("replaces a provider registered again under the same id", () => {
    // Reloading a plugin re-registers its views. Refusing would make reload a
    // restart, and the old provider would keep rendering after its code changed.
    const views = createViewRegistry();
    const replacement = () => () => {};
    views.register("acme.inspector", noopProvider);
    views.register("acme.inspector", replacement);

    expect(views.resolve("acme.inspector")).toBe(replacement);
  });

  it("forgets a provider on unregister", () => {
    const views = createViewRegistry();
    views.register("acme.inspector", noopProvider);
    views.unregister("acme.inspector");

    expect(views.resolve("acme.inspector")).toBeNull();
    expect(views.list()).toEqual([]);
  });

  it("lists every registered id in registration order", () => {
    const views = createViewRegistry();
    views.register("acme.b", noopProvider);
    views.register("acme.a", noopProvider);

    expect(views.list()).toEqual(["acme.b", "acme.a"]);
  });
});
