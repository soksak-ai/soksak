import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, install, remote } = vi.hoisted(() => ({ invoke: vi.fn(), install: vi.fn(), remote: vi.fn() }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("../state/environmentEvents", () => ({ reconcileEnvironmentRevision: vi.fn() }));
vi.mock("../state/registry", () => ({ publicReleaseMetadataGet: (...args: unknown[]) => remote(...args) }));
vi.mock("./registryInstallRuntime", () => ({ installCertifiedRegistryRelease: (...args: unknown[]) => install(...args) }));

import { installLocalPlugin, installLocalSidecar, planLocalPlugin } from "./localReleaseInstallService";
import { pluginInstallProgress } from "./registryInstallProgress";

const hash = async (body: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const integrity = (repository: string, version: string, name: string, body: string) => ({ url: `${repository}/releases/download/v${version}/${name}`, size: body.length, sha256: "a".repeat(64) });

describe("local release planning and installation", () => {
  let pluginBody = ""; let sidecarBody = "";
  beforeEach(async () => {
    invoke.mockReset(); install.mockReset(); remote.mockReset();
    const sidecarRepo = "https://github.com/example/soksak-sidecar-state";
    sidecarBody = JSON.stringify({ kind: "sidecar", id: "soksak-sidecar-state", version: "0.0.1", manifest: integrity(sidecarRepo, "0.0.1", "sidecar.json", "x"), source: { repository: sidecarRepo, commit: "b".repeat(40) }, artifacts: [{ ...integrity(sidecarRepo, "0.0.1", "state.tgz", "x"), target: "aarch64-apple-darwin", format: "tgz", manifest: "sidecar.json" }], evidence: [integrity(sidecarRepo, "0.0.1", "conformance-release.json", "x")] });
    const sidecar = { id: "soksak-sidecar-state", version: "0.0.1", url: `${sidecarRepo}/releases/download/v0.0.1/release.json`, size: sidecarBody.length, sha256: await hash(sidecarBody) };
    const pluginRepo = "https://github.com/example/soksak-plugin-demo";
    pluginBody = JSON.stringify({ kind: "plugin", id: "soksak-plugin-demo", version: "0.0.1", manifest: integrity(pluginRepo, "0.0.1", "plugin.json", "x"), source: { repository: pluginRepo, commit: "a".repeat(40) }, artifacts: [{ ...integrity(pluginRepo, "0.0.1", "demo.tgz", "x"), target: "any", format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [sidecar] }, evidence: [integrity(pluginRepo, "0.0.1", "conformance-release.json", "x")] });
    invoke.mockImplementation(async (_command: string, args: { id: string }) => {
      const body = args.id === "soksak-plugin-demo" ? pluginBody : sidecarBody;
      return { found: true, body, size: body.length, sha256: await hash(body) };
    });
  });

  it("plans a complete local closure without remote fallback", async () => {
    const plan = await planLocalPlugin("/store", "soksak-plugin-demo", "0.0.1");
    expect(plan.releases.map((release) => release.kind)).toEqual(["plugin", "sidecar"]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(remote).not.toHaveBeenCalled();
  });

  it("refuses a stale plan before invoking the installer", async () => {
    const result = await installLocalPlugin("/store", "soksak-plugin-demo", "0.0.1", "0".repeat(64));
    expect(result).toMatchObject({ ok: false, code: "LOCAL_INSTALL_PLAN_CHANGED" });
    expect(install).not.toHaveBeenCalled();
  });

  it("finishes progress as failed when plan revalidation throws", async () => {
    invoke.mockRejectedValueOnce(new Error("store unreadable"));
    const result = await installLocalPlugin("/store", "broken-plugin", "0.0.1", "0".repeat(64));
    expect(result).toMatchObject({ ok: false, code: "LOCAL_RELEASE_INVALID" });
    expect(pluginInstallProgress("broken-plugin")).toMatchObject([{ phase: "failed", error: "store unreadable" }]);
  });

  it("refuses an in-use Sidecar without stopping it", async () => {
    invoke.mockResolvedValueOnce({ open: [{ name: "soksak-sidecar-state" }], recorded: [] });
    const result = await installLocalSidecar("/store", "soksak-sidecar-state", "0.0.1", "0".repeat(64));
    expect(result).toMatchObject({ ok: false, code: "SIDECAR_IN_USE" });
    expect(invoke).not.toHaveBeenCalledWith("sidecar_stop", expect.anything());
    expect(install).not.toHaveBeenCalled();
  });
});
