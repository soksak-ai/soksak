// The canonical plugin release builder is the single source every plugin cuts its release through.
// These fix its contract: identity/version derive from the unit's own manifests, the caller declares
// only files, outputs are deterministic, and the boundary invariants refuse a malformed unit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRegularFileArchive } from "../src/releaseArchive.js";
import { buildPluginRelease } from "../src/releaseBuild.js";

const COMMIT = "a".repeat(40);
const FILES = ["LICENSE", "NOTICE", "README.ko.md", "README.md", "main.js", "plugin.json"];

let root = "";
let outDir = "";

function writeFixture(overrides: {
  pkg?: Record<string, unknown>;
  plugin?: Record<string, unknown>;
} = {}): void {
  const pkg = {
    name: "soksak-plugin-example",
    version: "0.0.1",
    private: true,
    license: "Apache-2.0",
    type: "module",
    ...overrides.pkg,
  };
  const plugin = {
    spec: "soksak-spec-plugin@0.0.1",
    id: "soksak-plugin-example",
    name: { en: "Example", ko: "예제" },
    version: "0.0.1",
    entry: "main.js",
    permissions: ["data"],
    ...overrides.plugin,
  };
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "main.js"), "export default { controller: {} };\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache-2.0\n");
  fs.writeFileSync(path.join(root, "NOTICE"), "soksak\n");
  fs.writeFileSync(path.join(root, "README.md"), "# example\n");
  fs.writeFileSync(path.join(root, "README.ko.md"), "# 예제\n");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-root-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("buildPluginRelease — canonical plugin release", () => {
  it("derives identity/version from the unit manifests and emits the declared artifacts", () => {
    writeFixture();
    const result = buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES });

    expect(result.archive).toBe("soksak-plugin-example-0.0.1-any.tgz");
    expect(fs.existsSync(path.join(outDir, result.archive))).toBe(true);

    const release = JSON.parse(fs.readFileSync(path.join(outDir, "release.json")).toString());
    expect(release).toMatchObject({
      spec: "soksak-spec-release@0.0.1",
      kind: "plugin",
      id: "soksak-plugin-example",
      version: "0.0.1",
      releaseTag: "v0.0.1",
      source: { repository: "https://github.com/soksak-ai/soksak-plugin-example", commit: COMMIT },
    });
    expect(release.artifacts[0]).toMatchObject({ target: "any", format: "tgz", sha256: result.sha256 });

    const names = readRegularFileArchive(fs.readFileSync(path.join(outDir, result.archive))).map(
      (e) => e.name,
    );
    expect(names).toEqual(FILES);

    for (const report of ["conformance-release.json", "conformance-plugin.json"]) {
      expect(fs.existsSync(path.join(outDir, report))).toBe(true);
    }
  });

  it("is deterministic — same inputs produce the same archive sha256", () => {
    writeFixture();
    const a = buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES });
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-out2-"));
    const b = buildPluginRelease({ root, commit: COMMIT, outDir: out2, files: FILES });
    fs.rmSync(out2, { recursive: true, force: true });
    expect(a.sha256).toBe(b.sha256);
  });

  it("does not pin which contracts a unit relates to — any well-formed consumes passes", () => {
    writeFixture({ plugin: { consumes: [{ id: "soksak-spec-plugin-git", range: "0.0.1" }] } });
    expect(() => buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES })).not.toThrow();
  });

  it("refuses a malformed consumes entry (shape is validated)", () => {
    writeFixture({ plugin: { consumes: [{ id: "soksak-spec-plugin-git" }] } });
    expect(() => buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES })).toThrow(
      /consumes\[0\] has invalid keys/,
    );
  });

  it("refuses a non-Apache-2.0 owner package (private product boundary)", () => {
    writeFixture({ pkg: { license: "MIT" } });
    expect(() => buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES })).toThrow(
      /private product boundary/,
    );
  });

  it("refuses a stale spec id (public plugin boundary)", () => {
    writeFixture({ plugin: { spec: "soksak-spec-plugin@1" } });
    expect(() => buildPluginRelease({ root, commit: COMMIT, outDir, files: FILES })).toThrow(
      /public plugin boundary/,
    );
  });

  it("refuses a non-SHA commit", () => {
    writeFixture();
    expect(() => buildPluginRelease({ root, commit: "v0.0.1", outDir, files: FILES })).toThrow(
      /40-character Git commit/,
    );
  });
});
