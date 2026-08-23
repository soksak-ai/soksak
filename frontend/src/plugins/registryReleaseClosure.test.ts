import { describe, expect, it, vi } from "vitest";
import { loadReleaseClosure } from "./registryReleaseClosure";
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
describe("registry release closure", () => {
  it("loads exact plugin and sidecar releases without credentials", async () => {
    const sidecarBody = JSON.stringify({ kind: "sidecar", id: "sidecar", version: "0.0.1", manifest: { url: "https://github.com/example/sidecar/releases/download/v0.0.1/sidecar.json", size: 1, sha256: "a".repeat(64) }, source: { repository: "https://github.com/example/sidecar", commit: "a".repeat(40) }, artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/example/sidecar/releases/download/v0.0.1/sidecar.tgz", size: 1, sha256: "b".repeat(64), format: "tgz", manifest: "sidecar.json" }], evidence: [{ url: "https://github.com/example/sidecar/releases/download/v0.0.1/conformance-release.json", size: 1, sha256: "c".repeat(64) }] });
    const sidecar = { id: "sidecar", version: "0.0.1", url: "https://github.com/example/sidecar/releases/download/v0.0.1/release.json", size: sidecarBody.length, sha256: await hash(sidecarBody) };
    const pluginBody = JSON.stringify({ kind: "plugin", id: "plugin", version: "0.0.1", manifest: { url: "https://github.com/example/plugin/releases/download/v0.0.1/plugin.json", size: 1, sha256: "a".repeat(64) }, source: { repository: "https://github.com/example/plugin", commit: "a".repeat(40) }, artifacts: [{ target: "any", url: "https://github.com/example/plugin/releases/download/v0.0.1/plugin.tgz", size: 1, sha256: "b".repeat(64), format: "tgz", manifest: "plugin.json" }], runtimeDependencies: { sidecars: [sidecar] }, evidence: [{ url: "https://github.com/example/plugin/releases/download/v0.0.1/conformance-release.json", size: 1, sha256: "c".repeat(64) }] });
    const plugin = { id: "plugin", version: "0.0.1", url: "https://github.com/example/plugin/releases/download/v0.0.1/release.json", size: pluginBody.length, sha256: await hash(pluginBody) };
    const get = vi.fn(async (url: string) => ({ status: 200, body: url.includes("/plugin/") ? pluginBody : sidecarBody }));
    await expect(loadReleaseClosure(plugin, get)).resolves.toMatchObject([{ kind: "plugin" }, { kind: "sidecar" }]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("rejects a digest mismatch before parsing", async () => {
    const root = { id: "plugin", version: "0.0.1", url: "https://github.com/example/plugin/releases/download/v0.0.1/release.json", size: 2, sha256: "0".repeat(64) };
    await expect(loadReleaseClosure(root, async () => ({ status: 200, body: "{}" }))).rejects.toThrow(/digest/);
  });
});
