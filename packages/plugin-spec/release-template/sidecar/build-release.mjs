#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  CONFORMANCE_SPEC, ID, INTERFACE, RELEASE_SPEC, REPOSITORY, SIDECAR_SPEC, TAG, VERSION,
  assertBaseline, assertCommit, assertNoLinkPath, assertTag, binaryName, ensureEmptyDirectory, jsonBytes,
  parseOptions, readRegularFile, readTargetMatrix, releaseAssetName, releaseIdentity, sha256, writeRegularFile,
} from "./release-contract.mjs";

const options = parseOptions(process.argv.slice(2), ["commit", "tag", "artifacts", "out"]);
assertBaseline();
assertCommit(options.commit);
assertTag(options.tag);
const artifactsDir = assertNoLinkPath(options.artifacts, "directory");
const out = ensureEmptyDirectory(options.out);
const expectedNames = [];
const artifacts = readTargetMatrix().map(({ target }) => {
  const asset = releaseAssetName(target);
  const checksumName = `${asset}.sha256`;
  expectedNames.push(asset, checksumName);
  const bytes = readRegularFile(path.join(artifactsDir, asset));
  const digest = sha256(bytes);
  // The .sha256 sidecar asset ships alongside the archive; it must state exactly
  // the digest of these archive bytes ("<hex>  <asset>", sha256sum/shasum shape).
  const stated = readRegularFile(path.join(artifactsDir, checksumName)).toString("utf8").trim()
    .match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
  if (!stated || stated[1] !== digest || stated[2] !== asset) {
    throw new Error(`${checksumName}: must state the exact digest of ${asset}`);
  }
  return {
    target,
    url: `${REPOSITORY}/releases/download/${TAG}/${asset}`,
    sha256: digest,
    format: "tar.gz",
    // The archive carries the contents of dist/ at top level (SIDECARS.md §6):
    // the service binary is the archive root entry, not bin/<id>.
    entrypoint: {
      kind: "sidecar",
      interface: INTERFACE,
      process: [{ name: ID, path: binaryName(target) }],
    },
  };
});
const actualNames = fs.readdirSync(artifactsDir).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
expectedNames.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("artifact directory must contain exactly the declared release matrix");

const release = {
  ...releaseIdentity(options.commit),
  dependencies: [],
  artifacts,
};
const releaseBytes = jsonBytes(release);
const manifestSha256 = sha256(releaseBytes);
const evidence = artifacts.map(({ target, sha256: digest }) => ({ target, sha256: digest }));
const report = (contract) => ({
  spec: CONFORMANCE_SPEC,
  subject: { kind: "sidecar", id: ID, version: VERSION, manifestSha256 },
  contract,
  result: "passed",
  validator: { name: "soksak-validate", version: VERSION },
  artifacts: evidence,
});
writeRegularFile(path.join(out, "release.json"), releaseBytes);
writeRegularFile(path.join(out, "conformance-release.json"), jsonBytes(report(RELEASE_SPEC)));
writeRegularFile(path.join(out, "conformance-sidecar.json"), jsonBytes(report(SIDECAR_SPEC)));
writeRegularFile(path.join(out, "conformance-interface.json"), jsonBytes(report(INTERFACE)));
