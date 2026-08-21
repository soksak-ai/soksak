import { describe, expect, it } from "vitest";
import { declaredEntrypoints } from "../registryInstaller";
import { parseReleaseManifest } from "./release";

const release = (kind: "plugin" | "sidecar" | "kit", entrypoint: unknown) => ({
  spec: "soksak-spec-release@0.0.1",
  kind,
  id: "demo-" + kind,
  version: "0.0.1",
  source: {
    repository: "https://github.com/example/demo-" + kind,
    commit: "0123456789abcdef0123456789abcdef01234567",
  },
  releaseTag: "demo-" + kind + "-v0.0.1",
  dependencies: [],
  artifacts: [{
    target: kind === "sidecar" ? "aarch64-apple-darwin" : "any",
    url: "https://github.com/example/demo-" + kind + "/releases/download/demo-" + kind + "-v0.0.1/demo.tgz",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    format: "tgz",
    unitManifest: "soksak-unit.json",
    entrypoint,
  }],
});

describe("release composition manifest", () => {
  it.each([
    ["plugin", { kind: "plugin", manifest: "plugin.json" }],
    ["sidecar", { kind: "sidecar", interface: { id: "soksak-spec-sidecar-demo", version: "0.0.1" }, process: [{ name: "demo", path: "bin/demo" }] }],
    ["kit", { kind: "kit", packageManifest: "package.json" }],
  ] as const)("requires the common unit manifest for %s", (kind, entrypoint) => {
    const result = parseReleaseManifest(release(kind, entrypoint));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifacts[0].unitManifest).toBe("soksak-unit.json");
    expect(declaredEntrypoints(result.value.artifacts[0])).toContain("soksak-unit.json");
  });

  it("rejects an artifact with no common unit manifest", () => {
    const raw = release("plugin", { kind: "plugin", manifest: "plugin.json" });
    delete (raw.artifacts[0] as Record<string, unknown>).unitManifest;
    const result = parseReleaseManifest(raw);
    expect(result.ok).toBe(false);
  });
});
