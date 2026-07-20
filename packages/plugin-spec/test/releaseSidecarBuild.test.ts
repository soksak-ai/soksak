// The canonical sidecar release builder (release-template/sidecar/) is the single source every
// sidecar vendors byte-identical (scripts/{release-contract,build-release,validate-with-spec}.mjs)
// and runs in its publish job to emit the owner manifest + conformance reports the signed registry
// requires. These run the real artifacts as a unit would — a fixture unit with release/unit.json,
// release/targets.json, the validator pin, and a five-target archive set — and fix the contract:
// identity derives from the unit's own metadata, the emitted release.json carries per-target
// artifacts with the interface entrypoint, and the boundary invariants refuse a malformed unit.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release-template/sidecar");
const COMMIT = "b".repeat(40);
const SPEC_COMMIT = "d7f54852754195527f125d1fc11362316157d19b";
const TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
];

let root = "";
let artifactsDir = "";
let outDir = "";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeFixture(overrides: { unit?: Record<string, unknown>; cargoVersion?: string } = {}): void {
  const unit = {
    id: "soksak-sidecar-example",
    version: "0.0.1",
    releaseTag: "v0.0.1",
    repository: "https://github.com/soksak-ai/soksak-sidecar-example",
    interface: { id: "soksak-spec-sidecar-example", version: "0.0.1" },
    ...overrides.unit,
  };
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  fs.mkdirSync(path.join(root, "validation"), { recursive: true });
  for (const name of ["release-contract.mjs", "build-release.mjs", "validate-with-spec.mjs"]) {
    fs.copyFileSync(path.join(TEMPLATE, name), path.join(root, "scripts", name));
  }
  fs.writeFileSync(path.join(root, "release", "unit.json"), `${JSON.stringify(unit, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "release", "targets.json"),
    `${JSON.stringify(TARGETS.map((target) => ({ target, runner: "runner" })), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "validation", "spec-validator.json"),
    `${JSON.stringify({ repository: "https://github.com/soksak-ai/soksak-spec", commit: SPEC_COMMIT, validator: "packages/plugin-spec/bin/validate.mjs" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    `[package]\nname = "${unit.id}"\nversion = "${overrides.cargoVersion ?? unit.version}"\npublish = false\n`,
  );
  for (const target of TARGETS) {
    const asset = `${unit.id}-${unit.version}-${target}.tar.gz`;
    const bytes = Buffer.from(`archive-bytes-${target}`);
    fs.writeFileSync(path.join(artifactsDir, asset), bytes);
    fs.writeFileSync(path.join(artifactsDir, `${asset}.sha256`), `${sha256(bytes)}  ${asset}\n`);
  }
}

// A release runs FROM its unit. deVendored runs the CANONICAL template script, vendored runs the copy
// beside the unit — either way the unit ROOT is DISCOVERED by its marker from the run directory
// (the fixture root), never cwd-guessed or passed as an argument (DEPLOY §1).
function build(tag = "v0.0.1", emitSummary = false, deVendored = false): { status: number | null; stdout: string; stderr: string } {
  const script = deVendored
    ? path.join(TEMPLATE, "build-release.mjs")
    : path.join(root, "scripts", "build-release.mjs");
  const args = [script, "--commit", COMMIT, "--tag", tag, "--artifacts", artifactsDir, "--out", outDir];
  if (emitSummary) args.push("--emit-summary");
  const r = spawnSync("node", args, { encoding: "utf8", cwd: root });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const SUMMARY_MARK = "@@RELEASE_SUMMARY@@ ";

beforeEach(() => {
  // The canon refuses any symlink on the path walk — macOS tmpdir sits behind the /var symlink,
  // so anchor fixtures at the resolved real path (exactly what a CI checkout gives the scripts).
  const tmp = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(tmp, "sidecar-rel-root-"));
  artifactsDir = fs.mkdtempSync(path.join(tmp, "sidecar-rel-art-"));
  outDir = path.join(fs.mkdtempSync(path.join(tmp, "sidecar-rel-out-")), "dist-release");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(outDir), { recursive: true, force: true });
});

describe("release-template/sidecar — canonical sidecar release documents", () => {
  it("emits the owner manifest and three conformance reports from the unit's own metadata", () => {
    writeFixture();
    const r = build();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const release = JSON.parse(fs.readFileSync(path.join(outDir, "release.json"), "utf8"));
    expect(release).toMatchObject({
      spec: "soksak-spec-release@0.0.1",
      kind: "sidecar",
      id: "soksak-sidecar-example",
      version: "0.0.1",
      releaseTag: "v0.0.1",
      source: { repository: "https://github.com/soksak-ai/soksak-sidecar-example", commit: COMMIT },
    });
    expect(release.artifacts).toHaveLength(5);
    expect(release.artifacts.map((a: { target: string }) => a.target)).toEqual(TARGETS);
    for (const artifact of release.artifacts) {
      expect(artifact.format).toBe("tar.gz");
      expect(artifact.entrypoint).toMatchObject({
        kind: "sidecar",
        interface: { id: "soksak-spec-sidecar-example", version: "0.0.1" },
      });
      expect(artifact.entrypoint.process[0].name).toBe("soksak-sidecar-example");
    }
    const windows = release.artifacts.find((a: { target: string }) => a.target.includes("windows"));
    expect(windows.entrypoint.process[0].path).toBe("soksak-sidecar-example.exe");

    const manifestSha256 = sha256(fs.readFileSync(path.join(outDir, "release.json")));
    const contracts: Record<string, unknown> = {
      "conformance-release.json": "soksak-spec-release@0.0.1",
      "conformance-sidecar.json": "soksak-spec-sidecar@0.0.1",
      "conformance-interface.json": { id: "soksak-spec-sidecar-example", version: "0.0.1" },
    };
    for (const [name, contract] of Object.entries(contracts)) {
      const report = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8"));
      expect(report).toMatchObject({
        spec: "soksak-spec-conformance@0.0.1",
        subject: { kind: "sidecar", id: "soksak-sidecar-example", version: "0.0.1", manifestSha256 },
        contract,
        result: "passed",
      });
      expect(report.artifacts).toHaveLength(5);
    }
  });

  // --emit-summary lets a caller (the core `release.build` command handler) parse the manifest +
  // per-target digests from stdout instead of re-hashing the bytes itself. Additive: without the
  // flag stdout stays silent, and every invariant above still fires.
  it("with --emit-summary, prints a parseable summary matching the written manifest", () => {
    writeFixture();
    const r = build("v0.0.1", true);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith(SUMMARY_MARK));
    expect(line, "a @@RELEASE_SUMMARY@@ line must be printed").toBeDefined();
    const summary = JSON.parse(line!.slice(SUMMARY_MARK.length));
    const releaseBytes = fs.readFileSync(path.join(outDir, "release.json"));
    expect(summary.manifestSha256).toBe(sha256(releaseBytes));
    expect(summary.releaseJson).toEqual(JSON.parse(releaseBytes.toString("utf8")));
    expect(summary.matrix).toHaveLength(5);
    expect(summary.matrix.map((m: { target: string }) => m.target)).toEqual(TARGETS);
  });

  it("stays silent on stdout without --emit-summary (additive flag)", () => {
    writeFixture();
    const r = build();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("discovers the unit by its marker when run de-vendored from the single source (never cwd-guessed)", () => {
    // The core release command runs the CANONICAL script (from soksak-spec) at the unit's directory;
    // the builder discovers this unit by release/unit.json and produces its manifest without a copy.
    writeFixture();
    const r = build("v0.0.1", false, true);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const release = JSON.parse(fs.readFileSync(path.join(outDir, "release.json"), "utf8"));
    expect(release.id).toBe("soksak-sidecar-example");
    expect(release.artifacts).toHaveLength(5);
  });

  it("refuses a checksum sidecar that does not state the exact archive digest", () => {
    writeFixture();
    const asset = "soksak-sidecar-example-0.0.1-x86_64-apple-darwin.tar.gz";
    fs.writeFileSync(path.join(artifactsDir, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must state the exact digest/);
  });

  it("refuses an artifact directory that is not exactly the declared matrix", () => {
    writeFixture();
    fs.writeFileSync(path.join(artifactsDir, "stray.txt"), "stray");
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exactly the declared release matrix/);
  });

  it("refuses a dispatch tag that does not equal the unit's releaseTag", () => {
    writeFixture();
    const r = build("v9.9.9");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/release tag must equal v0\.0\.1/);
  });

  it("refuses a Cargo package whose version drifted from the release metadata", () => {
    writeFixture({ cargoVersion: "0.0.9" });
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Cargo package must match private release metadata/);
  });

  it("refuses an interface id outside the sidecar contract namespace", () => {
    writeFixture({ unit: { interface: { id: "soksak-browser-spec", version: "0.0.1" } } });
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/interface provider must match the unit version/);
  });
});
