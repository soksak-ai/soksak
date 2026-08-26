import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const framework = vi.hoisted(() => ({
  name: "wails",
  invoke: async () => undefined,
  createStream: () => ({ onmessage: () => {}, close() {} }),
  listen: async () => () => {},
  currentWindow: () => { throw new Error("not used"); },
  titlebarComposition: {
    buttonPositions: { provided: false, reason: "not exposed" },
    backingPlane: { provided: true },
    paintOwner: { provided: true },
  },
  app: { name: async () => "", version: async () => "" },
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  framework,
}));

import { registerRuntimeCatalog } from "./catalogRuntime";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => registerRuntimeCatalog());
afterEach(() => unregister("runtime.capabilities"));

describe("runtime.capabilities", () => {
  it("replaces the framework identity command", () => {
    expect(getSpec("framework.info")).toBeUndefined();
    expect(getSpec("runtime.capabilities")).toBeDefined();
  });

  it("returns capabilities and titlebar composition without a framework identity", async () => {
    const result = await execute("runtime.capabilities", {}, {});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      capabilities: expect.arrayContaining(["invoke", "app.name", "app.version"]),
      titlebarComposition: framework.titlebarComposition,
      titlebarBreaches: [],
    });
    expect(result.data).not.toHaveProperty("framework");
  });
});
