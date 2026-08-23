import { describe, expect, it, vi } from "vitest";
import { installRegistryRelease, type VerifiedInstallRelease } from "./registryInstallTransaction";
const digest = (value: string) => value.repeat(64);
const ref = { id: "state", version: "0.0.1", url: "https://github.com/example/state/releases/download/v0.0.1/release.json", size: 1, sha256: digest("a") };
const plugin = { kind: "plugin", id: "demo", version: "0.0.1", manifest: { url: "https://github.com/example/demo/releases/download/v0.0.1/plugin.json", size: 1, sha256: digest("b") }, source: { repository: "https://github.com/example/demo", commit: "1".repeat(40) }, artifacts: [{ target: "any", url: "https://github.com/example/demo/releases/download/v0.0.1/demo.tgz", size: 3, sha256: digest("c"), format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [ref] }, evidence: [{ url: "https://github.com/example/demo/releases/download/v0.0.1/report.json", size: 1, sha256: digest("d") }] } as const;
const sidecar = { kind: "sidecar", id: "state", version: "0.0.1", manifest: { url: "https://github.com/example/state/releases/download/v0.0.1/sidecar.json", size: 1, sha256: digest("e") }, source: { repository: "https://github.com/example/state", commit: "2".repeat(40) }, artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/example/state/releases/download/v0.0.1/state.tgz", size: 4, sha256: digest("f"), format: "tgz", manifest: "sidecar.json" }], evidence: [{ url: "https://github.com/example/state/releases/download/v0.0.1/report.json", size: 1, sha256: digest("1") }] } as const;
const certified = { registry: { id: "official" } } as never;
const environment = { revision: 1, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} } as const;
function artifacts(over: { pluginDependencies?: unknown } = {}) {
  const rollback = vi.fn(async () => {});
  let committed: readonly VerifiedInstallRelease[] = [];
  const commit = vi.fn(async (_transactionId: string, _expectedRevision: number, releases: readonly VerifiedInstallRelease[]) => { committed = releases; return { revision: 2 }; });
  return { rollback, commit, get committed() { return committed; }, value: { begin: async () => ({ transactionId: "tx" }), stage: async ({ release }: { release: { id: string; kind: string } }) => ({ handle: release.id, sha256: release.kind === "plugin" ? digest("c") : digest("f"), size: release.kind === "plugin" ? 3 : 4, manifestSha256: digest("2"), extraction: "regular-files-only" as const, verifiedEntrypoints: [`${release.kind}.json`] }), readUtf8: async (_: string, handle: string) => handle === "demo" ? JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: ["sidecar"], runtimeDependencies: over.pluginDependencies ?? { sidecars: [ref] } }) : JSON.stringify({ id: "state", version: "0.0.1", interface: { id: "soksak-spec-sidecar-state", version: "0.0.1" }, process: "dist/state" }), commit, rollback } };
}
describe("atomic registry installation", () => {
  it("installs the plugin and exact sidecar closure without role selection", async () => { const a=artifacts(); const progress=vi.fn(); const result=await installRegistryRelease({ certified, root:{kind:"plugin",id:"demo",version:"0.0.1"}, releases:[plugin,sidecar] as never, target:"aarch64-apple-darwin", environment, artifacts:a.value, onProgress:progress }); expect(result).toMatchObject({ok:true,revision:2}); expect(a.commit).toHaveBeenCalledOnce(); expect(a.committed.find((value)=>value.kind==="plugin")).not.toHaveProperty("target"); expect(a.committed.find((value)=>value.kind==="sidecar")).toHaveProperty("target","aarch64-apple-darwin"); expect(progress.mock.calls.map(([value])=>value)).toEqual([
    {phase:"staging",completed:0,total:2,componentId:"demo"},
    {phase:"staging",completed:1,total:2,componentId:"demo"},
    {phase:"staging",completed:1,total:2,componentId:"state"},
    {phase:"staging",completed:2,total:2,componentId:"state"},
    {phase:"committing",completed:2,total:2},
  ]); });
  it("rolls back when the staged manifest differs from the release", async () => { const a=artifacts({pluginDependencies:{sidecars:[]}}); const result=await installRegistryRelease({ certified, root:{kind:"plugin",id:"demo",version:"0.0.1"}, releases:[plugin,sidecar] as never, target:"aarch64-apple-darwin", environment, artifacts:a.value }); expect(result).toMatchObject({ok:false,code:"RELEASE_VERIFICATION_FAILED"}); expect(a.rollback).toHaveBeenCalledWith("tx"); });
});
