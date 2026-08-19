// How an edge sidebar takes its room, for either edge, from one command.
//
// There was `sidebar.right.mode` and nothing for the left. The left edge has the same setting and
// the same two values, and its default is `push` — so the first thing a person meets there was a
// setting nothing outside could read or drive (C2: command, status, DOM — all three, or the feature
// is unfinished). Measured 2026-08-19: the left edge drew on the wrong side of the window in `push`
// and no command could put it in the other mode to tell the two apart.
//
// One command with the place as a parameter, not one command per edge. Two commands are two places
// to change a rule that is one rule, and the second one is the one that gets forgotten.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { registerCatalog } from "./catalog";
import { execute, getSpec } from "./registry";
import { useSettings } from "../state/settings";

registerCatalog();

const run = (params: Record<string, unknown>) =>
  execute("sidebar.edge.mode", params, {}) as unknown as Promise<{
    ok: boolean;
    code?: string;
    data?: { place?: string; mode?: string };
  }>;

describe("sidebar.edge.mode", () => {
  beforeEach(() => {
    useSettings.setState({ leftSidebarMode: "push", rightSidebarMode: "overlay" });
  });

  it("answers each edge's mode without changing it", async () => {
    expect((await run({ place: "left" })).data).toEqual({ place: "left", mode: "push" });
    expect((await run({ place: "right" })).data).toEqual({ place: "right", mode: "overlay" });
    expect(useSettings.getState().leftSidebarMode).toBe("push");
  });

  it("sets the edge that was named, and only that one", async () => {
    await run({ place: "left", mode: "overlay" });
    expect(useSettings.getState().leftSidebarMode).toBe("overlay");
    expect(useSettings.getState().rightSidebarMode).toBe("overlay");

    await run({ place: "right", mode: "push" });
    expect(useSettings.getState().rightSidebarMode).toBe("push");
    expect(useSettings.getState().leftSidebarMode).toBe("overlay");
  });

  it("refuses a place that is not an edge, by name", async () => {
    // The rail takes its room from the panes and has no such setting. Accepted here, the answer
    // would be about a setting that does not exist.
    const r = await run({ place: "rail", mode: "push" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("refuses a mode that is not one of the two", async () => {
    const r = await run({ place: "left", mode: "float" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("leaves no per-edge command behind", async () => {
    // Kept beside this one, the two would drift and a person driving the old name would be setting
    // a rule the new one no longer states (L11c).
    expect(getSpec("sidebar.right.mode")).toBeUndefined();
  });
});
