import { describe, expect, it, vi } from "vitest";
import { githubReleaseResolver, localReleaseFile, localStoreReleaseResolver, publishedReleaseFile } from "./releaseResolver";

describe("release location derivation", () => {
  it("derives the published file from id, version, and bare file name", () => {
    expect(publishedReleaseFile("soksak-plugin-demo", "0.0.1", "release.json")).toBe("https://github.com/soksak-ai/soksak-plugin-demo/releases/download/v0.0.1/release.json");
    expect(publishedReleaseFile("soksak-plugin-demo", "0.0.1", "soksak-plugin-demo-0.0.1-any.tgz")).toBe("https://github.com/soksak-ai/soksak-plugin-demo/releases/download/v0.0.1/soksak-plugin-demo-0.0.1-any.tgz");
  });
  it("derives the local store file from store, kind, id, version, and bare file name", () => {
    expect(localReleaseFile("/store", "plugin", "soksak-plugin-demo", "0.0.1", "release.json")).toBe("/store/plugins/soksak-plugin-demo/0.0.1/release.json");
    expect(localReleaseFile("/store", "sidecar", "soksak-sidecar-state", "0.0.2", "state.tgz")).toBe("/store/sidecars/soksak-sidecar-state/0.0.2/state.tgz");
  });
  it("refuses segments outside the component id, version, and file grammars", () => {
    expect(() => publishedReleaseFile("../etc", "0.0.1", "release.json")).toThrow(/component id/);
    expect(() => publishedReleaseFile("demo", "v0.0.1", "release.json")).toThrow(/version/);
    expect(() => publishedReleaseFile("demo", "0.0.1", "../release.json")).toThrow(/file/);
    expect(() => localReleaseFile("/store", "plugin", "demo", "0.0.1", "a/b.tgz")).toThrow(/file/);
    expect(() => localReleaseFile("store", "plugin", "demo", "0.0.1", "release.json")).toThrow(/absolute/);
  });
});

describe("github release resolver", () => {
  it("reads release.json at the derived published location", async () => {
    const get = vi.fn(async () => ({ status: 200, body: "{}" }));
    await expect(githubReleaseResolver(get)({ kind: "sidecar", id: "soksak-sidecar-state", version: "0.0.1" })).resolves.toBe("{}");
    expect(get).toHaveBeenCalledWith("https://github.com/soksak-ai/soksak-sidecar-state/releases/download/v0.0.1/release.json");
  });
  it("names the derived location when the release is absent", async () => {
    const get = vi.fn(async () => ({ status: 404, body: "" }));
    await expect(githubReleaseResolver(get)({ kind: "plugin", id: "demo", version: "0.0.1" })).rejects.toThrow("unresolved release demo@0.0.1: https://github.com/soksak-ai/demo/releases/download/v0.0.1/release.json");
  });
});

describe("local store release resolver", () => {
  it("reads release.json by store, kind, id, and version", async () => {
    const read = vi.fn(async () => ({ found: true, body: "{}", size: 2, sha256: "a".repeat(64) }));
    await expect(localStoreReleaseResolver("/store", read)({ kind: "plugin", id: "demo", version: "0.0.1" })).resolves.toBe("{}");
    expect(read).toHaveBeenCalledWith({ store: "/store", kind: "plugin", id: "demo", version: "0.0.1" });
  });
  it("names the derived store file when the release is absent", async () => {
    const read = vi.fn(async () => ({ found: false }));
    await expect(localStoreReleaseResolver("/store", read)({ kind: "sidecar", id: "state", version: "0.0.1" })).rejects.toThrow("unresolved release state@0.0.1: /store/sidecars/state/0.0.1/release.json");
  });
});
