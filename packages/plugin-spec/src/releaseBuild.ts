// Canonical plugin release builder — the single, dependency-declared interface every plugin uses to
// cut its release, replacing the per-unit copied scripts that drifted apart. A unit imports this and
// declares only what is genuinely its own: the exact file set it ships. Everything else — identity,
// version, the boundary invariants, the archive, the release manifest, the conformance reports — is
// derived from the unit's own owner manifests (package.json + plugin.json) and produced here, once.
//
// No unit-specific coupling lives here: a plugin's declared `implements`/`consumes` are validated for
// shape only (the manifest is the single source of truth for which contracts it relates to), never
// pinned to a hardcoded contract. Relations between units are declarations, not code baked into a
// shared builder.
import fs from "node:fs";
import path from "node:path";

import { createRegularFileArchive, readRegularFileArchive, sha256 } from "./releaseArchive.js";
import { isStrictSemver } from "./semver.js";

export interface BuildPluginReleaseInput {
  /** The unit repository root (holds package.json + plugin.json). */
  root: string;
  /** Exact lowercase 40-character Git commit the release is cut from. */
  commit: string;
  /** Output directory for the archive, release.json, and conformance reports. */
  outDir: string;
  /** The exact, ordered file set the unit ships — its own declaration. */
  files: string[];
}

export interface BuildPluginReleaseResult {
  archive: string;
  sha256: string;
}

function exactKeys(value: unknown, keys: string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} has invalid keys`);
  }
}

/**
 * Build a plugin unit's release artifacts (archive + release.json + conformance) into `outDir`.
 * Identity and version come from the unit's own manifests; the caller declares only `files`.
 */
export function buildPluginRelease(input: BuildPluginReleaseInput): BuildPluginReleaseResult {
  const { root, commit, outDir, files } = input;
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("commit must be an exact lowercase 40-character Git commit SHA");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("release file set must be a non-empty array");
  }

  const manifestBytes = fs.readFileSync(path.join(root, "plugin.json"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")).toString()) as Record<
    string,
    unknown
  >;
  const plugin = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;

  const version = pkg.version;
  if (typeof version !== "string" || !isStrictSemver(version)) {
    throw new Error("package version must be strict SemVer");
  }
  const id = plugin.id;
  if (typeof id !== "string") throw new Error("plugin manifest id must be a string");

  // Private product boundary — the owner package never publishes to a language registry.
  if (pkg.name !== id || pkg.private !== true || pkg.license !== "Apache-2.0") {
    throw new Error("package manifest does not satisfy the private product boundary");
  }
  if (
    pkg.publishConfig !== undefined ||
    Object.keys((pkg.scripts as Record<string, unknown>) ?? {}).some((name) => /publish/i.test(name))
  ) {
    throw new Error("language-registry publication is forbidden");
  }
  // Public plugin boundary — the manifest is a plugin at this version, entered at main.js, no repo leak.
  if (
    plugin.spec !== "soksak-spec-plugin@0.0.1" ||
    plugin.version !== version ||
    plugin.entry !== "main.js" ||
    "repo" in plugin
  ) {
    throw new Error("plugin manifest does not satisfy the public plugin boundary");
  }
  // Contract relations are validated for shape only — the manifest owns which contracts it relates to.
  for (const [index, provider] of ((plugin.implements as unknown[]) ?? []).entries()) {
    exactKeys(provider, ["id", "version"], `implements[${index}]`);
  }
  for (const [index, consumer] of ((plugin.consumes as unknown[]) ?? []).entries()) {
    exactKeys(consumer, ["id", "range"], `consumes[${index}]`);
  }

  const dependencies = Object.entries((plugin.dependencies as Record<string, unknown>) ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([depId, range]) => {
      if (typeof range !== "string") throw new Error(`plugin dependency range must be a string: ${depId}`);
      return { kind: "plugin", id: depId, range };
    });

  const repository = `https://github.com/soksak-ai/${id}`;
  const tag = `v${version}`;
  const archiveName = `${id}-${version}-any.tgz`;
  const archive = createRegularFileArchive({ root, files });
  const archived = readRegularFileArchive(archive);
  if (JSON.stringify(archived.map((entry) => entry.name)) !== JSON.stringify(files)) {
    throw new Error("release archive inventory diverges from the declared file set");
  }
  const archivedManifest = archived.find((entry) => entry.name === "plugin.json");
  if (!archivedManifest || !archivedManifest.data.equals(manifestBytes)) {
    throw new Error("release archive plugin manifest differs from the validated source bytes");
  }

  const artifactSha256 = sha256(archive);
  const artifact = {
    target: "any",
    url: `${repository}/releases/download/${tag}/${archiveName}`,
    sha256: artifactSha256,
    format: "tgz",
    entrypoint: { kind: "plugin", manifest: "plugin.json" },
  };
  const release = {
    spec: "soksak-spec-release@0.0.1",
    kind: "plugin",
    id,
    version,
    source: { repository, commit },
    releaseTag: tag,
    dependencies,
    artifacts: [artifact],
  };
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  const manifestSha256 = sha256(releaseBytes);
  const report = (contract: string) => ({
    spec: "soksak-spec-conformance@0.0.1",
    subject: { kind: "plugin", id, version, manifestSha256 },
    contract,
    result: "passed",
    validator: { name: "soksak-unit-conformance", version },
    artifacts: [{ target: "any", sha256: artifactSha256 }],
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, archiveName), archive);
  fs.writeFileSync(path.join(outDir, "release.json"), releaseBytes);
  fs.writeFileSync(
    path.join(outDir, "conformance-release.json"),
    `${JSON.stringify(report("soksak-spec-release@0.0.1"), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outDir, "conformance-plugin.json"),
    `${JSON.stringify(report("soksak-spec-plugin@0.0.1"), null, 2)}\n`,
  );
  return { archive: archiveName, sha256: artifactSha256 };
}
