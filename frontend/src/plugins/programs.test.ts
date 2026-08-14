import { describe, expect, it } from "vitest";

import { createProgramRegistry } from "./programs";

describe("program registry", () => {
  it("carries a program the core has never heard of", () => {
    const programs = createProgramRegistry();
    programs.register({ id: "acme.notebook", title: "Notebook", viewId: "acme.notebook.view" });

    expect(programs.resolve("acme.notebook")).toEqual({
      id: "acme.notebook",
      title: "Notebook",
      viewId: "acme.notebook.view",
    });
  });

  it("answers absence with null", () => {
    expect(createProgramRegistry().resolve("acme.missing")).toBeNull();
  });

  it("lists programs in registration order for the add menu", () => {
    // The add menu is a projection of this list. A core that sorts or filters
    // here would be deciding which plugins deserve to appear.
    const programs = createProgramRegistry();
    programs.register({ id: "acme.b", title: "B", viewId: "acme.b.view" });
    programs.register({ id: "acme.a", title: "A", viewId: "acme.a.view" });

    expect(programs.list().map((program) => program.id)).toEqual(["acme.b", "acme.a"]);
  });

  it("rejects a program whose view is not declared", () => {
    const programs = createProgramRegistry();

    expect(() => programs.register({ id: "acme.x", title: "X", viewId: "" })).toThrow(/viewId/);
  });

  it("forgets a program on unregister", () => {
    const programs = createProgramRegistry();
    programs.register({ id: "acme.notebook", title: "Notebook", viewId: "acme.notebook.view" });
    programs.unregister("acme.notebook");

    expect(programs.resolve("acme.notebook")).toBeNull();
    expect(programs.list()).toEqual([]);
  });
});
