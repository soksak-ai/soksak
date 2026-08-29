import { describe, expect, it, vi } from "vitest";
import { installRegistryRelease, installRegistryReleases, type RegistryArtifactStager, type VerifiedInstallRelease } from "./registryInstallTransaction";
const digest = (value: string) => value.repeat(64);
const ref = { id: "state", version: "0.0.1", size: 1, sha256: digest("a") };
const plugin = { kind: "plugin", id: "demo", version: "0.0.1", manifest: { file: "plugin.json", size: 1, sha256: digest("b") }, source: { repository: "https://github.com/soksak-ai/demo", commit: "1".repeat(40) }, artifacts: [{ target: "any", file: "demo-0.0.1-any.tgz", size: 3, sha256: digest("c"), format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [ref] }, evidence: [{ file: "report.json", size: 1, sha256: digest("d") }] } as const;
const pluginPeer = { ...plugin, id: "peer", source: { ...plugin.source, repository: "https://github.com/soksak-ai/peer", commit: "3".repeat(40) }, artifacts: [{ ...plugin.artifacts[0], file: "peer-0.0.1-any.tgz", sha256: digest("9") }] } as const;
const sidecar = { kind: "sidecar", id: "state", version: "0.0.1", manifest: { file: "sidecar.json", size: 1, sha256: digest("e") }, source: { repository: "https://github.com/soksak-ai/state", commit: "2".repeat(40) }, artifacts: [{ target: "aarch64-apple-darwin", file: "state-0.0.1-aarch64-apple-darwin.tgz", size: 4, sha256: digest("f"), format: "tgz", manifest: "sidecar.json" }], evidence: [{ file: "report.json", size: 1, sha256: digest("1") }] } as const;
const environment = { revision: 1, plugins: {}, sidecars: {} } as const;
// pluginDependencies replaces the staged plugin.json runtimeDependencies; an explicit undefined omits the key.
function artifacts(over: { pluginDependencies?: unknown } = {}) {
  const rollback = vi.fn(async () => {});
  let committed: readonly VerifiedInstallRelease[] = [];
  const begin = vi.fn<RegistryArtifactStager["begin"]>(async () => ({ transactionId: "tx" }));
  const commit = vi.fn(async (_transactionId: string, _expectedRevision: number, releases: readonly VerifiedInstallRelease[]) => { committed = releases; return { revision: 2 }; });
  const stage = vi.fn<RegistryArtifactStager["stage"]>(async ({ release }) => ({ handle: release.id, sha256: release.id === "peer" ? digest("9") : release.kind === "plugin" ? digest("c") : digest("f"), size: release.kind === "plugin" ? 3 : 4, manifestSha256: digest("2"), extraction: "regular-files-only" as const, verifiedEntrypoints: [`${release.kind}.json`] }));
  const pluginDependencies = "pluginDependencies" in over ? over.pluginDependencies : { sidecars: [{ id: "state", version: "0.0.1" }] };
  return { rollback, begin, commit, stage, get committed() { return committed; }, value: { begin, stage, readUtf8: async (_: string, handle: string) => handle === "demo" || handle === "peer" ? JSON.stringify({ id: handle, name: handle, version: "0.0.1", appVersionRequirement: "0.0.1", description: handle, permissions: ["sidecar"], runtimeDependencies: pluginDependencies }) : JSON.stringify({ id: "state", version: "0.0.1", processRole: "sidecar-state", interface: [{ id: "soksak-spec-sidecar-state", version: "0.0.1" }], process: "dist/state" }), commit, rollback } };
}
describe("atomic registry installation", () => {
  it("commits two plugin roots and their shared dependency in one transaction", async () => {
    const a = artifacts();
    const result = await installRegistryReleases({
      sourceId: "local", localStore: "/store",
      roots: [
        { kind: "plugin", id: "demo", version: "0.0.1" },
        { kind: "plugin", id: "peer", version: "0.0.1" },
      ],
      releases: [plugin, pluginPeer, sidecar] as never,
      target: "aarch64-apple-darwin", environment, artifacts: a.value,
    });
    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(a.committed.map((value) => `${value.kind}:${value.id}`)).toEqual([
      "plugin:demo", "plugin:peer", "sidecar:state",
    ]);
    expect(a.commit).toHaveBeenCalledOnce();
  });
  it("installs the plugin and exact sidecar closure without role selection", async () => { const a=artifacts(); const progress=vi.fn(); const result=await installRegistryRelease({ sourceId:"official", root:{kind:"plugin",id:"demo",version:"0.0.1"}, releases:[plugin,sidecar] as never, target:"aarch64-apple-darwin", environment, artifacts:a.value, onProgress:progress }); expect(result).toMatchObject({ok:true,revision:2}); expect(a.commit).toHaveBeenCalledOnce(); expect(a.committed.find((value)=>value.kind==="plugin")).not.toHaveProperty("target"); expect(a.committed.find((value)=>value.kind==="sidecar")).toHaveProperty("target","aarch64-apple-darwin"); expect(progress.mock.calls.map(([value])=>value)).toEqual([
    {phase:"staging",completed:0,total:2,componentId:"demo"},
    {phase:"staging",completed:1,total:2,componentId:"demo"},
    {phase:"staging",completed:1,total:2,componentId:"state"},
    {phase:"staging",completed:2,total:2,componentId:"state"},
    {phase:"committing",completed:2,total:2},
  ]); });
  // The stager derives every location from the release identity and the bare file name; the
  // transaction hands over those two and no location, and the committed record holds no location.
  it("hands the stager the release identity and the bare artifact file name, never a location", async () => {
    const a = artifacts();
    await installRegistryRelease({ sourceId: "official", root: { kind: "plugin", id: "demo", version: "0.0.1" }, releases: [plugin, sidecar] as never, target: "aarch64-apple-darwin", environment, artifacts: a.value });
    expect(a.stage.mock.calls.map(([input]) => input)).toEqual([
      { transactionId: "tx", registryId: "official", release: { kind: "plugin", id: "demo", version: "0.0.1" }, artifact: plugin.artifacts[0] },
      { transactionId: "tx", registryId: "official", release: { kind: "sidecar", id: "state", version: "0.0.1" }, artifact: sidecar.artifacts[0] },
    ]);
    expect(a.committed.map((value) => Object.keys(value).sort())).toEqual([
      ["artifactSha256", "id", "kind", "manifestSha256", "registryId", "sourceCommit", "sourceRepository", "stagedHandle", "version"],
      ["artifactSha256", "id", "kind", "manifestSha256", "registryId", "sourceCommit", "sourceRepository", "stagedHandle", "target", "version"],
    ]);
  });
  it("addresses the local store once, at begin", async () => {
    const a = artifacts();
    await installRegistryRelease({ sourceId: "local", localStore: "/store", root: { kind: "plugin", id: "demo", version: "0.0.1" }, releases: [plugin, sidecar] as never, target: "aarch64-apple-darwin", environment, artifacts: a.value });
    expect(a.begin).toHaveBeenCalledWith({ registryId: "local", root: { kind: "plugin", id: "demo", version: "0.0.1" }, localStore: "/store" });
    expect(a.stage.mock.calls.map(([input]) => Object.keys(input).sort())).toEqual([["artifact", "registryId", "release", "transactionId"], ["artifact", "registryId", "release", "transactionId"]]);
  });
  it("rolls back when the release declares a dependency the staged manifest does not", async () => {
    const a = artifacts({ pluginDependencies: undefined });
    const result = await installRegistryRelease({ sourceId: "official", root: { kind: "plugin", id: "demo", version: "0.0.1" }, releases: [plugin, sidecar] as never, target: "aarch64-apple-darwin", environment, artifacts: a.value });
    expect(result).toMatchObject({ ok: false, code: "RELEASE_VERIFICATION_FAILED", errors: [expect.stringContaining("state@0.0.1")] });
    expect(a.rollback).toHaveBeenCalledWith("tx");
    expect(a.commit).not.toHaveBeenCalled();
  });
  it("rolls back when the release lacks a dependency the staged manifest declares", async () => {
    const a = artifacts({ pluginDependencies: { sidecars: [{ id: "other", version: "0.0.2" }, { id: "state", version: "0.0.1" }] } });
    const result = await installRegistryRelease({ sourceId: "official", root: { kind: "plugin", id: "demo", version: "0.0.1" }, releases: [plugin, sidecar] as never, target: "aarch64-apple-darwin", environment, artifacts: a.value });
    expect(result).toMatchObject({ ok: false, code: "RELEASE_VERIFICATION_FAILED", errors: [expect.stringContaining("other@0.0.2")] });
    expect(a.rollback).toHaveBeenCalledWith("tx");
    expect(a.commit).not.toHaveBeenCalled();
  });
  it("repairs a dependency mismatch even when the root Plugin artifact is already materialized", async () => {
    const a = artifacts();
    const installed = {
      revision: 3,
      plugins: { demo: { version: "0.0.1", path: "/installed/demo", artifactSha256: digest("c"), source: "registry" as const, registry: "official", enabled: true } },
      sidecars: { state: { version: "0.0.0", path: "/installed/state", process: "/installed/state/dist/soksakv3-sidecar-state", artifactSha256: digest("0"), source: "registry" as const, registry: "official", target: "aarch64-apple-darwin" } },
    };
    const result = await installRegistryRelease({ sourceId: "official", root: { kind: "plugin", id: "demo", version: "0.0.1" }, releases: [plugin, sidecar] as never, target: "aarch64-apple-darwin", environment: installed, artifacts: a.value });
    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(a.committed.map((value) => `${value.kind}:${value.id}@${value.version}`)).toEqual(["sidecar:state@0.0.1"]);
  });
});
