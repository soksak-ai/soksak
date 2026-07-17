import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invoke, closure, loadBytes } = vi.hoisted(() => ({
  invoke: vi.fn(),
  closure: vi.fn(),
  loadBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../state/registry", () => ({ loadRegistryResourceBytes: loadBytes }));
vi.mock("./registryInstaller", async (orig) => {
  const actual = await orig<typeof import("./registryInstaller")>();
  return { ...actual, installRegistryClosure: (req: unknown) => closure(req) };
});

import { installCertifiedRegistryUnit } from "./registryInstallRuntime";
import { wireNativeRegistryInstall } from "./registryInstallRuntimeNative";

const CERTIFIED = { index: { registryId: "fixture" } } as any;
const ROOT = { kind: "plugin", id: "weather-plugin", version: "0.0.1" } as any;

describe("native registry install wiring", () => {
  let restore = () => {};
  beforeEach(() => {
    invoke.mockReset();
    closure.mockReset();
  });
  afterEach(() => {
    restore();
    restore = () => {};
  });

  it("the default runtime is unavailable until wired (RED baseline)", async () => {
    const result = await installCertifiedRegistryUnit({ certified: CERTIFIED, root: ROOT });
    expect(result).toMatchObject({ ok: false, code: "INSTALL_RUNTIME_UNAVAILABLE" });
  });

  it("runs the closure and maps a committed generation to the root identity", async () => {
    closure.mockResolvedValue({ ok: true, registryId: "fixture", generation: "generation-7", units: [] });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryUnit({ certified: CERTIFIED, root: ROOT });
    expect(result).toEqual({ ok: true, id: "weather-plugin", version: "0.0.1", generation: "generation-7" });
    const req = closure.mock.calls[0]![0] as any;
    expect(req.certified).toBe(CERTIFIED);
    expect(req.root).toBe(ROOT);
    expect(req.documents.load).toBeTypeOf("function");
    expect(req.artifacts.begin).toBeTypeOf("function");
    expect(req.target).toBeTypeOf("string");
  });

  it("maps a fail-closed closure error to a runtime error result", async () => {
    closure.mockResolvedValue({ ok: false, code: "RELEASE_VERIFICATION_FAILED", errors: ["bad sha", "x"] });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryUnit({ certified: CERTIFIED, root: ROOT });
    expect(result).toMatchObject({
      ok: false,
      code: "RELEASE_VERIFICATION_FAILED",
      message: "bad sha; x",
      errors: ["bad sha", "x"],
    });
  });

  it("stages a plugin artifact through the native command with computed entrypoints", async () => {
    closure.mockImplementation(async (req: any) => {
      invoke.mockResolvedValueOnce({ transactionId: "t1" });
      await req.artifacts.begin({ registryId: "fixture", root: ROOT });
      invoke.mockResolvedValueOnce({
        handle: "h1",
        sha256: "abc",
        extraction: "regular-files-only",
        verifiedEntrypoints: ["plugin.json"],
      });
      await req.artifacts.stage({
        transactionId: "t1",
        registryId: "fixture",
        unit: ROOT,
        artifact: {
          target: "any",
          url: "https://x/a.tgz",
          sha256: "abc",
          format: "tgz",
          entrypoint: { kind: "plugin", manifest: "plugin.json" },
        },
      });
      return { ok: true, registryId: "fixture", generation: "g", units: [] };
    });
    restore = wireNativeRegistryInstall();
    await installCertifiedRegistryUnit({ certified: CERTIFIED, root: ROOT });
    expect(invoke).toHaveBeenCalledWith("unit_install_begin", { registryId: "fixture", root: ROOT });
    expect(invoke).toHaveBeenCalledWith("unit_install_stage", {
      transactionId: "t1",
      registryId: "fixture",
      unit: ROOT,
      artifact: { url: "https://x/a.tgz", sha256: "abc", format: "tgz", entrypoints: ["plugin.json"] },
    });
  });
});
