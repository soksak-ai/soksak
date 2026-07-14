import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  manifestViolations,
  packagePolicyViolations,
  scanPlatformBoundaries,
  stageRepository,
  verifyReleaseArtifacts,
} from "./platform-boundary-scan.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("public platform boundary", () => {
  it("rejects registry publishing and first-party registry dependencies", () => {
    expect(packagePolicyViolations({ name: "x" }, "x")).toContain("x: private:true is required");
    expect(
      packagePolicyViolations(
        { private: true, dependencies: { "@soksak-ai/plugin-spec": "^1.0.0" } },
        "sdk",
      ),
    ).toContain(
      "sdk: first-party dependencies.@soksak-ai/plugin-spec would resolve through a package registry (^1.0.0)",
    );
    expect(
      packagePolicyViolations(
        { private: true, devDependencies: { "@soksak-ai/plugin-spec": "workspace:0.3.0" } },
        "sdk",
      ),
    ).toContain(
      "sdk: first-party devDependencies.@soksak-ai/plugin-spec belongs in the repository workspace root (workspace:0.3.0)",
    );
  });

  it("keeps the repository extraction inventory and ownership boundary exact", () => {
    expect(scanPlatformBoundaries(REPO_ROOT)).toEqual([]);
  });

  it("never auto-installs first-party peers from a package registry", () => {
    const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const lock = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(workspace).toMatch(/^autoInstallPeers:\s*false$/m);
    expect(lock).not.toMatch(/^\s{2}'@soksak-ai\/[a-z0-9-]+@\d/m);
  });

  it("bootstraps spec then SDK before every root build and test", () => {
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(rootPackage.scripts["build:platform"]).toBe(
      "pnpm --filter @soksak-ai/plugin-spec build && pnpm --filter @soksak-ai/plugin-api build",
    );
    expect(rootPackage.scripts.prebuild).toBe("pnpm run build:platform");
    expect(rootPackage.scripts.pretest).toBe("pnpm run build:platform");
  });

  it("rejects extracting the private PTY contract", () => {
    const manifest = {
      schema: "ai.soksak/platform-extraction@1",
      repositories: [
        { name: "soksak-spec", units: [{ kind: "cargo", name: "soksak-spec-pty", source: "src-tauri/crates/soksak-spec-pty", destination: "crates/soksak-spec-pty", files: ["Cargo.toml", "src/lib.rs"] }] },
        { name: "soksak-plugin-sdk", units: [] },
      ],
      excludedBoundaries: [],
    };
    expect(manifestViolations(REPO_ROOT, manifest)).toContain(
      "extraction manifest: PTY contract is private core state and must not be extracted",
    );
  });

  it("rejects collecting another unit merely because it is public", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "platform/extraction-manifest.json"), "utf8"),
    );
    manifest.repositories[1].units.push({
      kind: "node",
      name: "@soksak-ai/unrelated-plugin",
      source: "packages/plugin-api",
      destination: "packages/unrelated-plugin",
      files: ["package.json"],
    });
    expect(manifestViolations(REPO_ROOT, manifest)).toContain(
      "soksak-plugin-sdk: extraction units differ from the approved ownership boundary",
    );
  });

  it("stages only the declared public source inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "soksak-spec-stage-test-"));
    try {
      stageRepository(REPO_ROOT, "soksak-spec", root);
      const workspace = readFileSync(join(root, "Cargo.toml"), "utf8");
      expect(workspace).toContain('"crates/soksak-spec-service"');
      expect(workspace).toContain('"crates/soksak-spec-socket"');
      expect(workspace).not.toContain("pty");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs spec and SDK separately and installs both exact tarballs without a registry", () => {
    const artifacts = verifyReleaseArtifacts(REPO_ROOT);
    expect(artifacts.spec.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.sdk.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);
});
