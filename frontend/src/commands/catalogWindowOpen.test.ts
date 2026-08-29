import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke,
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../lib/workspaceRoot", () => ({
  validateWorkspaceRoot: async (root: string) => root,
}));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => ["b", label, ""].join("-"),
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));

import { registerWindowCatalog } from "./catalogWindow";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerWindowCatalog();
});

afterEach(() => {
  for (const name of ["window.open"]) unregister(name);
});

it("window.open forwards focus:false to the native window contract so automation does not move the focus", async () => {
  expect(getSpec("window.open")?.params.focus).toMatchObject({ type: "boolean" });
  expect(getSpec("window.list")?.windowScoped).toBe(false);

  invoke.mockImplementation(async (command: string) => {
    if (command === "workspace_owners") return { owners: [] };
    if (command === "window_create") return "win-test";
    throw new Error(`unexpected invoke: ${command}`);
  });

  const result = await execute(
    "window.open",
    { root: "/workspace/soksak/core", focus: false },
    {},
  );

  expect(result).toMatchObject({ ok: true, data: { label: "win-test" } });
  expect(invoke).toHaveBeenCalledWith("window_create", {
    init: "root=%2Fworkspace%2Fsoksak%2Fcore",
    focus: false,
  });
});
