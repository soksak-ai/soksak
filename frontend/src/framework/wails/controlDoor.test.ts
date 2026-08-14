// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { installControlDoor } from "./controlDoor";

function scope() {
  return {} as Record<string, unknown>;
}

describe("control door", () => {
  it("publishes one door on the given scope", () => {
    const target = scope();
    installControlDoor({ scope: target, execute: vi.fn(), catalog: () => [] });

    expect(typeof (target.soksak as Record<string, unknown>).invoke).toBe("function");
    expect(typeof (target.soksak as Record<string, unknown>).commands).toBe("function");
  });

  it("passes the name and parameters straight through", async () => {
    const target = scope();
    const execute = vi.fn(async () => ({ ok: true, code: "OK", message: "", data: { depth: 7 } }));
    installControlDoor({ scope: target, execute, catalog: () => [] });

    const door = target.soksak as { invoke: (name: string, params?: unknown) => Promise<unknown> };
    await door.invoke("ui.tree", { depth: 2 });

    expect(execute).toHaveBeenCalledWith("ui.tree", { depth: 2 }, expect.anything());
  });

  it("answers with the whole envelope rather than just the data", async () => {
    // A caller that receives only the payload cannot tell a refusal from a
    // result that happens to be empty. The code and message travel with it.
    const target = scope();
    installControlDoor({
      scope: target,
      execute: async () => ({ ok: false, code: "NOT_EXPOSED", message: "no such node" }),
      catalog: () => [],
    });

    const door = target.soksak as { invoke: (name: string) => Promise<{ ok: boolean; code: string }> };
    await expect(door.invoke("ui.measure")).resolves.toMatchObject({ ok: false, code: "NOT_EXPOSED" });
  });

  it("reports the catalogue so a caller can discover what exists", async () => {
    const target = scope();
    installControlDoor({
      scope: target,
      execute: vi.fn(),
      catalog: () => [{ name: "ui.tree", description: "the tree" }],
    });

    const door = target.soksak as { commands: () => Promise<Array<{ name: string }>> };
    await expect(door.commands()).resolves.toEqual([{ name: "ui.tree", description: "the tree" }]);
  });

  it("survives being installed twice", async () => {
    // Reload re-runs boot. A door that threw on the second install would make
    // reload a restart.
    const target = scope();
    const first = vi.fn(async () => ({ ok: true, code: "OK", message: "", data: { n: 1 } }));
    const second = vi.fn(async () => ({ ok: true, code: "OK", message: "", data: { n: 2 } }));
    installControlDoor({ scope: target, execute: first, catalog: () => [] });
    installControlDoor({ scope: target, execute: second, catalog: () => [] });

    const door = target.soksak as { invoke: (name: string) => Promise<{ data: { n: number } }> };
    await expect(door.invoke("ui.tree")).resolves.toMatchObject({ data: { n: 2 } });
  });
});
