import { describe, expect, it, vi } from "vitest";
import { loadReleaseClosure, type ReleaseRead } from "./registryReleaseClosure";
import { githubReleaseResolver } from "./releaseResolver";

const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const integrity = (file: string) => ({ file, size: 1, sha256: "a".repeat(64) });
const repository = (id: string) => `https://github.com/soksak-ai/${id}`;
const sidecarRelease = (over: Record<string, unknown> = {}) => ({ kind: "sidecar", id: "sidecar", version: "0.0.1", manifest: integrity("sidecar.json"), source: { repository: repository("sidecar"), commit: "a".repeat(40) }, artifacts: [{ target: "aarch64-apple-darwin", ...integrity("sidecar-0.0.1-aarch64-apple-darwin.tgz"), format: "tgz", manifest: "sidecar.json" }], evidence: [integrity("conformance-release.json")], ...over });
const pluginRelease = (sidecar: unknown, over: Record<string, unknown> = {}) => ({ kind: "plugin", id: "plugin", version: "0.0.1", manifest: integrity("plugin.json"), source: { repository: repository("plugin"), commit: "a".repeat(40) }, artifacts: [{ target: "any", ...integrity("plugin-0.0.1-any.tgz"), format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [sidecar] }, evidence: [integrity("conformance-release.json")], ...over });

async function fixture(sidecarOver: Record<string, unknown> = {}, sidecarReferenceOver: Record<string, unknown> = {}, pluginOver: Record<string, unknown> = {}) {
  const sidecarBody = JSON.stringify(sidecarRelease(sidecarOver));
  const sidecar = { id: "sidecar", version: "0.0.1", size: sidecarBody.length, sha256: await hash(sidecarBody), ...sidecarReferenceOver };
  const pluginBody = JSON.stringify(pluginRelease(sidecar, pluginOver));
  const plugin = { id: "plugin", version: "0.0.1", size: pluginBody.length, sha256: await hash(pluginBody) };
  const read = vi.fn<ReleaseRead>(async (reference) => reference.id === "plugin" ? pluginBody : sidecarBody);
  return { plugin, read };
}

describe("registry release closure", () => {
  it("reads every release of the closure through the resolver by kind, id, and version", async () => {
    const { plugin, read } = await fixture();
    await expect(loadReleaseClosure(plugin, read)).resolves.toMatchObject([{ kind: "plugin" }, { kind: "sidecar" }]);
    expect(read.mock.calls.map(([reference]) => reference)).toEqual([
      { kind: "plugin", id: "plugin", version: "0.0.1" },
      { kind: "sidecar", id: "sidecar", version: "0.0.1" },
    ]);
  });
  it("derives the published release.json location for every read through the github resolver", async () => {
    const { plugin, read } = await fixture();
    const get = vi.fn(async (url: string) => ({ status: 200, body: await read(url.includes("/plugin/") ? { kind: "plugin", id: "plugin", version: "0.0.1" } : { kind: "sidecar", id: "sidecar", version: "0.0.1" }) }));
    await expect(loadReleaseClosure(plugin, githubReleaseResolver(get))).resolves.toHaveLength(2);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/soksak-ai/plugin/releases/download/v0.0.1/release.json",
      "https://github.com/soksak-ai/sidecar/releases/download/v0.0.1/release.json",
    ]);
  });
  it("rejects a digest mismatch before parsing", async () => {
    const root = { id: "plugin", version: "0.0.1", size: 2, sha256: "0".repeat(64) };
    await expect(loadReleaseClosure(root, async () => "{}")).rejects.toThrow(/digest/);
  });
  it("rejects a dependency reference that carries a url", async () => {
    const { plugin, read } = await fixture({}, { url: "https://github.com/soksak-ai/sidecar/releases/download/v0.0.1/release.json" });
    await expect(loadReleaseClosure(plugin, read)).rejects.toThrow(/runtimeDependencies\.sidecars\[0\].*"url"/);
  });
  it("rejects an artifact that carries a url", async () => {
    const { plugin, read } = await fixture({ artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/soksak-ai/sidecar/releases/download/v0.0.1/sidecar.tgz", size: 1, sha256: "a".repeat(64), format: "tgz", manifest: "sidecar.json" }] });
    await expect(loadReleaseClosure(plugin, read)).rejects.toThrow(/artifacts\[0\].*"url"/);
  });
});
