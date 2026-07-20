// The canonical plugin release builder (release-template/build-release.mjs) is the single source every
// plugin vendors byte-identical and runs to cut its release. These run the real artifact as a unit
// would — a fixture unit that declares only its file set — and fix the contract: identity/version
// derive from the unit's own manifests, outputs are deterministic, and the boundary invariants refuse
// a malformed unit. Testing the vendored .mjs directly keeps it the single source (no parallel copy).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRegularFileArchive } from "../release-template/archive.mjs";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release-template");
const COMMIT = "a".repeat(40);
const FILES = ["LICENSE", "NOTICE", "README.ko.md", "README.md", "main.js", "plugin.json"];

let root = "";
let outDir = "";

function writeFixture(overrides: { pkg?: Record<string, unknown>; plugin?: Record<string, unknown> } = {}): void {
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
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(TEMPLATE, "build-release.mjs"), path.join(root, "scripts", "build-release.mjs"));
  fs.copyFileSync(path.join(TEMPLATE, "archive.mjs"), path.join(root, "scripts", "archive.mjs"));
  fs.writeFileSync(path.join(root, "release-files.json"), `${JSON.stringify(FILES)}\n`);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "main.js"), "export default { controller: {} };\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache-2.0\n");
  fs.writeFileSync(path.join(root, "NOTICE"), "soksak\n");
  fs.writeFileSync(path.join(root, "README.md"), "# example\n");
  fs.writeFileSync(path.join(root, "README.ko.md"), "# 예제\n");
}

function build(out = outDir): { status: number | null; stdout: string; stderr: string } {
  // Run FROM the unit (fixture root) — ROOT is discovered by the release-files.json marker, not cwd-guessed.
  const r = spawnSync("node", [path.join(root, "scripts", "build-release.mjs"), "--commit", COMMIT, "--out", out], {
    encoding: "utf8",
    cwd: root,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-root-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("release-template/build-release.mjs — canonical plugin release", () => {
  it("derives identity/version from the unit manifests and emits the declared artifacts", () => {
    writeFixture();
    const r = build();
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.archive).toBe("soksak-plugin-example-0.0.1-any.tgz");

    const release = JSON.parse(fs.readFileSync(path.join(outDir, "release.json")).toString());
    expect(release).toMatchObject({
      spec: "soksak-spec-release@0.0.1",
      kind: "plugin",
      id: "soksak-plugin-example",
      version: "0.0.1",
      releaseTag: "v0.0.1",
      source: { repository: "https://github.com/soksak-ai/soksak-plugin-example", commit: COMMIT },
    });
    expect(release.artifacts[0]).toMatchObject({ target: "any", format: "tgz", sha256: out.sha256 });

    const names = readRegularFileArchive(fs.readFileSync(path.join(outDir, out.archive))).map((e) => e.name);
    expect(names).toEqual(FILES);
    for (const report of ["conformance-release.json", "conformance-plugin.json"]) {
      expect(fs.existsSync(path.join(outDir, report))).toBe(true);
    }
  });

  it("is deterministic — same inputs produce the same archive sha256", () => {
    writeFixture();
    const a = JSON.parse(build().stdout);
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "relbuild-out2-"));
    const b = JSON.parse(build(out2).stdout);
    fs.rmSync(out2, { recursive: true, force: true });
    expect(a.sha256).toBe(b.sha256);
  });

  it("does not pin which contracts a unit relates to — any well-formed consumes passes", () => {
    writeFixture({ plugin: { consumes: [{ id: "soksak-spec-plugin-git", range: "0.0.1" }] } });
    expect(build().status).toBe(0);
  });

  it("refuses a malformed consumes entry (shape is validated)", () => {
    writeFixture({ plugin: { consumes: [{ id: "soksak-spec-plugin-git" }] } });
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/consumes\[0\] has invalid keys/);
  });

  it("refuses a non-Apache-2.0 owner package (private product boundary)", () => {
    writeFixture({ pkg: { license: "MIT" } });
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/private product boundary/);
  });

  it("refuses a stale spec id (public plugin boundary)", () => {
    writeFixture({ plugin: { spec: "soksak-spec-plugin@1" } });
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/public plugin boundary/);
  });

  it("refuses a non-SHA commit", () => {
    writeFixture();
    const r = spawnSync("node", [path.join(root, "scripts", "build-release.mjs"), "--commit", "v0.0.1", "--out", outDir], {
      encoding: "utf8",
      cwd: root,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/40-character Git commit/);
  });
});
