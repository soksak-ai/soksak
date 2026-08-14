// Contract test for framework.info — reads the active framework's name and whether the contract
// capabilities are present, from outside. The framework is mocked: the point is that this command's
// answer reads **the adapter active at that moment** and not a constant, so the adapter name is
// changed and the answer checked against it. Capabilities are never called — an unimplemented one throws when called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake adapter in the exact contract shape. The values are never called (only presence is read).
// vi.hoisted — the mock factory is hoisted to the top of the file, so this object must hoist with it.
const { framework } = vi.hoisted(() => ({
  framework: {
    name: "tauri",
    invoke: async () => undefined,
    createStream: () => ({ onmessage: () => {} }),
    listen: async () => () => {},
    currentWindow: () => {
      throw new Error("the test adapter has no window");
    },
    windowByLabel: async () => null,
    app: { name: async () => "", version: async () => "" },
    path: { tempDir: async () => "", join: async () => "" },
    dialog: { openDirectory: async () => null },
    notification: {
      isPermissionGranted: async () => false,
      requestPermission: async () => "denied",
      send: () => {},
      onAction: async () => () => {},
    },
    deepLink: { onOpenUrl: async () => () => {}, current: async () => null },
  },
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  framework,
  invoke: async () => undefined,
  currentWindow: () => framework.currentWindow(),
}));

import { registerFrameworkCatalog } from "./catalogFramework";
import { execute, getSpec, unregister } from "./registry";
import { useSettings } from "../state/settings";

beforeEach(() => {
  framework.name = "tauri";
  registerFrameworkCatalog();
});
afterEach(() => {
  unregister("framework.info");
});

describe("framework.info registration (discoverability)", () => {
  it("no params, returns and examples declared", () => {
    const spec = getSpec("framework.info");
    expect(spec).toBeDefined();
    expect(Object.keys(spec!.params)).toHaveLength(0);
    expect(spec!.returns).toContain("framework");
    expect(spec!.returns).toContain("capabilities");
    expect(spec!.examples).toContain("framework.info");
  });
});

describe("framework.info execution (reports the active adapter)", () => {
  it("returns the active framework name", async () => {
    const r = await execute("framework.info", {}, {});
    expect(r).toMatchObject({ ok: true, data: { framework: "tauri" } });
  });

  it("the answer changes with the framework — it reads the active adapter, not a constant", async () => {
    framework.name = "electron";
    const r = await execute("framework.info", {}, {});
    expect(r).toMatchObject({ ok: true, data: { framework: "electron" } });
  });

  it("lists contract capabilities by name — a nested group flattens to a dotted path", async () => {
    const r = await execute("framework.info", {}, {});
    const caps = (r.data as { capabilities: string[] }).capabilities;
    expect(caps).toContain("invoke");
    expect(caps).toContain("currentWindow");
    expect(caps).toContain("app.version");
    expect(caps).toContain("notification.send");
    expect(caps).toContain("deepLink.onOpenUrl");
    // The name is identity, not a capability — the framework field reports it.
    expect(caps).not.toContain("name");
    // Deterministic order — an external ledger comparison does not break on order jitter.
    expect(caps).toEqual([...caps].sort());
  });

  // If the name the handler passes diverges from the sentence's placeholder, no substitution happens
  // and the literal goes out to the user as is — ok:true, so nobody notices. Both languages are
  // checked against the real sentence.
  it.each(["ko", "en"] as const)("the %s sentence fills in the framework name — no placeholder leaks", async (language) => {
    const before = useSettings.getState().language;
    useSettings.setState({ language });
    try {
      const r = await execute("framework.info", {}, {});
      expect(r.ok).toBe(true);
      expect(r.message).toContain("tauri");
      expect(r.message).not.toMatch(/\{[a-zA-Z]+\}/);
    } finally {
      useSettings.setState({ language: before });
    }
  });

  it("never calls a capability — an unimplemented adapter still answers", async () => {
    const boom = vi.fn(() => {
      throw new Error("not implemented");
    });
    const before = framework.windowByLabel;
    (framework as unknown as { windowByLabel: unknown }).windowByLabel = boom;
    try {
      const r = await execute("framework.info", {}, {});
      expect(r.ok).toBe(true);
      expect(boom).not.toHaveBeenCalled();
    } finally {
      (framework as unknown as { windowByLabel: unknown }).windowByLabel = before;
    }
  });
});
