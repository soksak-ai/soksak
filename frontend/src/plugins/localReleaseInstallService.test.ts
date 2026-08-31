import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, install, installBatch } = vi.hoisted(() => ({ invoke: vi.fn(), install: vi.fn(), installBatch: vi.fn() }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("../state/environmentEvents", () => ({ reconcileEnvironmentRevision: vi.fn() }));
vi.mock("./registryInstallRuntime", () => ({
  installCertifiedRegistryRelease: (...args: unknown[]) => install(...args),
  installCertifiedRegistryReleases: (...args: unknown[]) => installBatch(...args),
}));

import { installLocalPlugin, installLocalPlugins, installLocalSidecar, planLocalPlugin, planLocalPlugins, planLocalSidecar } from "./localReleaseInstallService";
import { pluginInstallProgress } from "./registryInstallProgress";

const hash = async (body: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const integrity = (file: string, body: string) => ({ file, size: body.length, sha256: "a".repeat(64) });
const PLUGIN = "soksak-plugin-demo";
const PEER = "soksak-plugin-peer";
const SIDECAR = "soksak-sidecar-state";

describe("local release planning and installation", () => {
  let pluginBody = ""; let peerBody = ""; let sidecarBody = "";
  const reads = () => invoke.mock.calls.filter(([command]) => command === "local_release_read").map(([, args]) => args);
  beforeEach(async () => {
    invoke.mockReset(); install.mockReset(); installBatch.mockReset();
    sidecarBody = JSON.stringify({ kind: "sidecar", id: SIDECAR, version: "0.0.1", manifest: integrity("sidecar.json", "x"), source: { repository: `https://github.com/soksak-ai/${SIDECAR}`, commit: "b".repeat(40) }, artifacts: [{ ...integrity("state.tgz", "x"), target: "aarch64-apple-darwin", format: "tgz", manifest: "sidecar.json" }], evidence: [integrity("conformance-release.json", "x")] });
    const sidecar = { id: SIDECAR, version: "0.0.1", size: sidecarBody.length, sha256: await hash(sidecarBody) };
    pluginBody = JSON.stringify({ kind: "plugin", id: PLUGIN, version: "0.0.1", manifest: integrity("plugin.json", "x"), source: { repository: `https://github.com/soksak-ai/${PLUGIN}`, commit: "a".repeat(40) }, artifacts: [{ ...integrity("demo.tgz", "x"), target: "any", format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [sidecar] }, evidence: [integrity("conformance-release.json", "x")] });
    peerBody = JSON.stringify({ ...JSON.parse(pluginBody), id: PEER, source: { repository: `https://github.com/soksak-ai/${PEER}`, commit: "c".repeat(40) }, artifacts: [{ ...integrity("peer.tgz", "x"), target: "any", format: "tgz", manifest: "plugin.json" }] });
    invoke.mockImplementation(async (command: string, args: { id: string }) => {
      if (command === "plugin_manifest_list") return [];
      if (command === "sidecar_status") return { open: [], recorded: [] };
      const body = args.id === PLUGIN ? pluginBody : args.id === PEER ? peerBody : sidecarBody;
      return { found: true, body, size: body.length, sha256: await hash(body) };
    });
  });

  it("reads every release of the closure from the addressed store by kind, id, and version", async () => {
    const plan = await planLocalPlugin("/store", PLUGIN, "0.0.1");
    expect(plan.releases.map((release) => release.kind)).toEqual(["plugin", "sidecar"]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(reads()).toEqual([
      { store: "/store", kind: "plugin", id: PLUGIN, version: "0.0.1" },
      { store: "/store", kind: "sidecar", id: SIDECAR, version: "0.0.1" },
    ]);
    expect(invoke).not.toHaveBeenCalledWith("net_http_request", expect.anything());
  });

  it("refuses a dependency absent from the store by its derived location", async () => {
    invoke.mockImplementation(async (command: string, args: { id: string }) => {
      if (command === "plugin_manifest_list") return [];
      if (args.id === PLUGIN) return { found: true, body: pluginBody, size: pluginBody.length, sha256: await hash(pluginBody) };
      return { found: false };
    });
    await expect(planLocalPlugin("/store", PLUGIN, "0.0.1")).rejects.toThrow(`unresolved release ${SIDECAR}@0.0.1: /store/sidecars/${SIDECAR}/0.0.1/release.json`);
    expect(invoke).not.toHaveBeenCalledWith("net_http_request", expect.anything());
  });

  it("hands the installer the store and a root reference pinned to the stored release.json", async () => {
    install.mockResolvedValue({ ok: true, id: PLUGIN, version: "0.0.1", revision: 2 });
    const plan = await planLocalPlugin("/store", PLUGIN, "0.0.1");
    const result = await installLocalPlugin("/store", PLUGIN, "0.0.1", plan.digest);
    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "local", localStore: "/store",
      root: { kind: "plugin", id: PLUGIN, version: "0.0.1", size: pluginBody.length, sha256: await hash(pluginBody) },
    }));
  });

  it("plans and installs two roots with their shared dependency in one atomic call", async () => {
    installBatch.mockResolvedValue({ ok: true, id: PLUGIN, version: "0.0.1", revision: 3 });
    const roots = [{ id: PLUGIN, version: "0.0.1" }, { id: PEER, version: "0.0.1" }];
    const plan = await planLocalPlugins("/store", roots);
    expect(plan.releases.map((release) => `${release.kind}:${release.id}`)).toEqual([
      `plugin:${PLUGIN}`, `plugin:${PEER}`, `sidecar:${SIDECAR}`,
    ]);
    const result = await installLocalPlugins("/store", roots, plan.digest);
    expect(result).toMatchObject({ ok: true, revision: 3 });
    expect(installBatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "local", localStore: "/store",
      roots: [
        { kind: "plugin", id: PLUGIN, version: "0.0.1", size: pluginBody.length, sha256: await hash(pluginBody) },
        { kind: "plugin", id: PEER, version: "0.0.1", size: peerBody.length, sha256: await hash(peerBody) },
      ],
    }));
  });

  it("refuses two roots that select different versions of the same Sidecar id", async () => {
    const sidecarV2Body = JSON.stringify({
      ...JSON.parse(sidecarBody),
      version: "0.0.2",
      source: {
        repository: `https://github.com/soksak-ai/${SIDECAR}`,
        commit: "d".repeat(40),
      },
    });
    const sidecarV2 = {
      id: SIDECAR,
      version: "0.0.2",
      size: sidecarV2Body.length,
      sha256: await hash(sidecarV2Body),
    };
    peerBody = JSON.stringify({
      ...JSON.parse(peerBody),
      runtimeDependencies: { sidecars: [sidecarV2] },
    });
    invoke.mockImplementation(async (command: string, args: { id: string; version: string }) => {
      if (command === "plugin_manifest_list") return [];
      if (command === "sidecar_status") return { open: [], recorded: [] };
      const body = args.id === PLUGIN
        ? pluginBody
        : args.id === PEER
          ? peerBody
          : args.version === "0.0.2"
            ? sidecarV2Body
            : sidecarBody;
      return { found: true, body, size: body.length, sha256: await hash(body) };
    });

    await expect(planLocalPlugins("/store", [
      { id: PLUGIN, version: "0.0.1" },
      { id: PEER, version: "0.0.1" },
    ])).rejects.toMatchObject({
      code: "DEPENDENCY_VERSION_CONFLICT",
      conflicts: [{
        kind: "sidecar",
        id: SIDECAR,
        versions: ["0.0.1", "0.0.2"],
        requiredBy: [
          { pluginId: PLUGIN, pluginVersion: "0.0.1", version: "0.0.1" },
          { pluginId: PEER, pluginVersion: "0.0.1", version: "0.0.2" },
        ],
      }],
    });
  });

  it("refuses a stale plan before invoking the installer", async () => {
    const result = await installLocalPlugin("/store", PLUGIN, "0.0.1", "0".repeat(64));
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
    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce({ open: [{ name: SIDECAR }], recorded: [] });
    const result = await installLocalSidecar("/store", SIDECAR, "0.0.1", "0".repeat(64));
    expect(result).toMatchObject({ ok: false, code: "SIDECAR_IN_USE" });
    expect(invoke).not.toHaveBeenCalledWith("sidecar_stop", expect.anything());
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses a Sidecar plan that would break an installed Plugin", async () => {
    invoke.mockImplementationOnce(async () => [{
      id: PLUGIN, version: "0.0.23",
      manifest: JSON.stringify({ runtimeDependencies: { sidecars: [{ id: SIDECAR, version: "0.0.12" }] } }),
    }]);
    await expect(planLocalSidecar("/store", SIDECAR, "0.0.13")).rejects.toMatchObject({
      code: "DEPENDENCY_VERSION_CONFLICT",
      conflict: { pluginId: PLUGIN, pluginVersion: "0.0.23", sidecarId: SIDECAR, requiredVersion: "0.0.12", requestedVersion: "0.0.13" },
    });
    expect(install).not.toHaveBeenCalled();
  });
});
