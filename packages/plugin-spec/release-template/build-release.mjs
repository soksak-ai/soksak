#!/usr/bin/env node
// Canonical plugin release builder — byte-identical across every plugin (vendored from the single
// source in @soksak-ai/plugin-spec, mirrored + gated by its test). A unit declares only its own file
// set in release-files.json; identity, version, the boundary invariants, the archive, the release
// manifest, and the conformance reports are derived from the unit's own manifests and produced once.
// No unit-specific coupling lives here: a plugin's implements/consumes are validated for shape only —
// the manifest is the single source of truth for which contracts it relates to.
import fs from "node:fs";
import path from "node:path";

import { createRegularFileArchive, readRegularFileArchive, sha256 } from "./archive.mjs";

// The UNIT repo root, resolved by a DISCOVERABLE RULE — not cwd guessing, not a carried argument
// (DEPLOY §1). A release always runs FROM its unit; we DISCOVER the plugin by finding its release
// file-set marker (release-files.json) at or above the running directory. Works identically whether
// this builder is vendored beside the unit or single-sourced from soksak-spec — ESM relative imports
// keep the LOGIC file-relative, only the unit is discovered.
const root = (() => {
  let dir = path.resolve(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, "release-files.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unit root not found: no release-files.json at or above ${process.cwd()}`);
    dir = parent;
  }
})();
const STRICT_SEMVER_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has invalid keys`);
  }
}

const commit = option("--commit");
const outDir = path.resolve(option("--out") ?? path.join(root, "dist"));
if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
  console.error("--commit must be an exact lowercase 40-character Git commit SHA");
  process.exit(2);
}

// The unit's own declaration: the exact, ordered file set it ships.
const FILES = JSON.parse(fs.readFileSync(path.join(root, "release-files.json")));
if (!Array.isArray(FILES) || FILES.length === 0) {
  throw new Error("release-files.json must declare a non-empty ordered file set");
}

const packageBytes = fs.readFileSync(path.join(root, "package.json"));
const manifestBytes = fs.readFileSync(path.join(root, "plugin.json"));
const pkg = JSON.parse(packageBytes);
const plugin = JSON.parse(manifestBytes);
if (typeof pkg.version !== "string" || pkg.version.length > 256 || !STRICT_SEMVER_RE.test(pkg.version)) {
  throw new Error("package version must be strict SemVer");
}
const VERSION = pkg.version;
const ID = plugin.id;
if (typeof ID !== "string") throw new Error("plugin manifest id must be a string");
if (pkg.name !== ID || pkg.private !== true || pkg.license !== "Apache-2.0") {
  throw new Error("package manifest does not satisfy the private product boundary");
}
if (pkg.publishConfig !== undefined || Object.keys(pkg.scripts ?? {}).some((name) => /publish/i.test(name))) {
  throw new Error("language-registry publication is forbidden");
}
if (
  plugin.spec !== "soksak-spec-plugin@0.0.1" ||
  plugin.version !== VERSION ||
  plugin.entry !== "main.js" ||
  "repo" in plugin
) {
  throw new Error("plugin manifest does not satisfy the public plugin boundary");
}
for (const [index, provider] of (plugin.implements ?? []).entries()) {
  exactKeys(provider, ["id", "version"], `implements[${index}]`);
}
for (const [index, consumer] of (plugin.consumes ?? []).entries()) {
  exactKeys(consumer, ["id", "range"], `consumes[${index}]`);
}

const dependencies = Object.entries(plugin.dependencies ?? {})
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .map(([id, range]) => {
    if (typeof range !== "string") throw new Error(`plugin dependency range must be a string: ${id}`);
    return { kind: "plugin", id, range };
  });
const REPOSITORY = `https://github.com/soksak-ai/${ID}`;
const tag = `v${VERSION}`;
const archiveName = `${ID}-${VERSION}-any.tgz`;
const archive = createRegularFileArchive({ root, files: FILES });
const archived = readRegularFileArchive(archive);
if (JSON.stringify(archived.map((entry) => entry.name)) !== JSON.stringify(FILES)) {
  throw new Error("release archive inventory diverges from the declared file set");
}
const archivedManifest = archived.find((entry) => entry.name === "plugin.json");
if (!archivedManifest || !archivedManifest.data.equals(manifestBytes)) {
  throw new Error("release archive plugin manifest differs from the validated source bytes");
}

const artifactSha256 = sha256(archive);
const artifact = {
  target: "any",
  url: `${REPOSITORY}/releases/download/${tag}/${archiveName}`,
  sha256: artifactSha256,
  format: "tgz",
  entrypoint: { kind: "plugin", manifest: "plugin.json" },
};
const release = {
  spec: "soksak-spec-release@0.0.1",
  kind: "plugin",
  id: ID,
  version: VERSION,
  source: { repository: REPOSITORY, commit },
  releaseTag: tag,
  dependencies,
  artifacts: [artifact],
};
const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
const manifestSha256 = sha256(releaseBytes);
const report = (contract) => ({
  spec: "soksak-spec-conformance@0.0.1",
  subject: { kind: "plugin", id: ID, version: VERSION, manifestSha256 },
  contract,
  result: "passed",
  validator: { name: "soksak-unit-conformance", version: VERSION },
  artifacts: [{ target: "any", sha256: artifactSha256 }],
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, archiveName), archive);
fs.writeFileSync(path.join(outDir, "release.json"), releaseBytes);
fs.writeFileSync(path.join(outDir, "conformance-release.json"), `${JSON.stringify(report("soksak-spec-release@0.0.1"), null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "conformance-plugin.json"), `${JSON.stringify(report("soksak-spec-plugin@0.0.1"), null, 2)}\n`);
console.log(JSON.stringify({ archive: archiveName, sha256: artifactSha256 }));
