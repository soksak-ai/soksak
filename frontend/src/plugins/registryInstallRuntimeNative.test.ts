import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invoke, closure, loadBytes } = vi.hoisted(() => ({
  invoke: vi.fn(),
  closure: vi.fn(),
  loadBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../state/registry", () => ({ loadRegistryResourceBytes: loadBytes }));
vi.mock("./registryInstallTransaction", async (orig) => {
  const actual = await orig<typeof import("./registryInstallTransaction")>();
  return { ...actual, installRegistryRelease: (req: unknown) => closure(req) };
});

import { installCertifiedRegistryRelease } from "./registryInstallRuntime";
import { wireNativeRegistryInstall } from "./registryInstallRuntimeNative";

const CERTIFIED = { registry: { id: "fixture" } } as any;
const ROOT = { kind: "plugin", id: "weather-plugin", version: "0.0.1" } as any;
const RELEASES: any[] = [];
const ENVIRONMENT = { revision: 4, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} };

describe("native registry install wiring", () => {
  let restore = () => {};
  beforeEach(() => {
    invoke.mockReset();
    closure.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "host_artifact_target") return "aarch64-apple-darwin";
      if (command === "environment_get") return ENVIRONMENT;
      return undefined;
    });
  });
  afterEach(() => {
    restore();
    restore = () => {};
  });

  it("the default runtime is unavailable until wired (RED baseline)", async () => {
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toMatchObject({ ok: false, code: "INSTALL_RUNTIME_UNAVAILABLE" });
  });

  it("runs the closure and maps a committed generation to the root identity", async () => {
    closure.mockResolvedValue({ ok: true, registryId: "fixture", revision: 7, releases: [] });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toEqual({ ok: true, id: "weather-plugin", version: "0.0.1", revision: 7 });
    const req = closure.mock.calls[0]![0] as any;
    expect(req.certified).toBe(CERTIFIED);
    expect(req.root).toEqual(ROOT);
    expect(req.environment).toEqual(ENVIRONMENT);
    expect(req.artifacts.begin).toBeTypeOf("function");
    expect(req.target).toBeTypeOf("string");
  });

  it("maps a fail-closed closure error to a runtime error result", async () => {
    closure.mockResolvedValue({ ok: false, code: "RELEASE_VERIFICATION_FAILED", errors: ["bad sha", "x"] });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toMatchObject({
      ok: false,
      code: "RELEASE_VERIFICATION_FAILED",
      message: "bad sha; x",
      errors: ["bad sha", "x"],
    });
  });

  it("refuses installation when the host artifact target is unavailable", async () => {
    invoke.mockRejectedValueOnce(new Error("host target unavailable"));
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toEqual({
      ok: false,
      code: "HOST_TARGET_UNAVAILABLE",
      message: "host target unavailable",
      errors: ["host target unavailable"],
    });
    expect(closure).not.toHaveBeenCalled();
  });

  it("stages a plugin artifact through the native command with computed entrypoints", async () => {
    closure.mockImplementation(async (req: any) => {
      invoke.mockResolvedValueOnce({ transactionId: "t1" });
      await req.artifacts.begin({ registryId: "fixture", root: ROOT });
      invoke.mockResolvedValueOnce({
        handle: "h1",
        sha256: "abc",
        size: 3,
        manifestSha256: "d".repeat(64),
        extraction: "regular-files-only",
        verifiedEntrypoints: ["plugin.json"],
      });
      await req.artifacts.stage({
        transactionId: "t1",
        registryId: "fixture",
        release: ROOT,
        artifact: {
          target: "any",
          url: "https://x/a.tgz",
          size: 3,
          sha256: "abc",
          format: "tgz",
          manifest: "plugin.json",
        },
      });
      return { ok: true, registryId: "fixture", generation: 1, releases: [] };
    });
    restore = wireNativeRegistryInstall();
    await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(invoke).toHaveBeenCalledWith("artifact_install_begin", { registryId: "fixture", root: ROOT });
    expect(invoke).toHaveBeenCalledWith("artifact_install_stage", {
      transactionId: "t1",
      registryId: "fixture",
      identity: ROOT,
      artifact: { url: "https://x/a.tgz", size: 3, sha256: "abc", format: "tgz", manifest: "plugin.json", entrypoints: ["plugin.json"] },
    });
  });

  it("commits against the current installed revision", async () => {
    const verified = [
      { ...ROOT, registryId: "fixture", sourceRepository: "https://github.com/example/plugin", sourceCommit: "p", releaseTag: "v0.0.1", artifactUrl: "https://x/p.tgz", artifactSha256: "p-sha", target: "any", manifestSha256: "a".repeat(64), stagedHandle: "p-handle" },
      { kind: "sidecar", id: "state", version: "0.0.1", registryId: "fixture", sourceRepository: "https://github.com/example/sidecar", sourceCommit: "s", releaseTag: "v0.0.1", artifactUrl: "https://x/s.tgz", artifactSha256: "s-sha", target: "aarch64-apple-darwin", manifestSha256: "b".repeat(64), stagedHandle: "s-handle" },
      { kind: "kit", id: "terminal-kit", version: "0.0.1", registryId: "fixture", sourceRepository: "https://github.com/example/kit", sourceCommit: "k", releaseTag: "v0.0.1", artifactUrl: "https://x/k.tgz", artifactSha256: "k-sha", target: "any", manifestSha256: "c".repeat(64), stagedHandle: "k-handle" },
    ];
    closure.mockImplementation(async (req: any) => {
      invoke.mockResolvedValueOnce({ revision: 5 });
      const committed = await req.artifacts.commit("t1", 4, verified, ROOT);
      return { ok: true, registryId: "fixture", revision: committed.revision, releases: [] };
    });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toEqual({ ok: true, id: "weather-plugin", version: "0.0.1", revision: 5 });
    expect(invoke).toHaveBeenCalledWith("environment_get");
    expect(invoke).toHaveBeenCalledWith("artifact_install_commit", {
      transactionId: "t1",
      expectedRevision: 4,
      components: verified,
    });
  });

  it("does not replace an unreadable environment revision with zero", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "host_artifact_target") return "aarch64-apple-darwin";
      if (command === "environment_get") throw new Error("environment unreadable");
      return undefined;
    });
    closure.mockImplementation(async (req: any) => {
      try {
        await req.artifacts.commit("t1", 4, [], ROOT);
        return { ok: true, registryId: "fixture", revision: 1, releases: [] };
      } catch (cause) {
        return { ok: false, code: "ATOMIC_INSTALL_FAILED", errors: [String(cause)] };
      }
    });
    restore = wireNativeRegistryInstall();
    const result = await installCertifiedRegistryRelease({ certified: CERTIFIED, root: ROOT, releases: RELEASES });
    expect(result).toMatchObject({
      ok: false,
      code: "ENVIRONMENT_UNAVAILABLE",
      message: expect.stringContaining("environment unreadable"),
    });
    expect(invoke).not.toHaveBeenCalledWith("artifact_install_commit", expect.objectContaining({
      expectedRevision: 0,
    }));
  });
});
