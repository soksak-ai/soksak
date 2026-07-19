#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, SPEC_SHA, assertNoLinkPath, parseOptions,
} from "./release-contract.mjs";

const options = parseOptions(process.argv.slice(2), ["spec-root", "release-dir"]);
const specRoot = assertNoLinkPath(options["spec-root"], "directory");
const releaseDir = assertNoLinkPath(options["release-dir"], "directory");
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "validation", "spec-validator.json"), "utf8"));
if (pin.commit !== SPEC_SHA) throw new Error("validator pin drift");
const head = spawnSync("git", ["-C", specRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
if (head.error) throw head.error;
if (head.status !== 0 || head.stdout.trim() !== SPEC_SHA) throw new Error(`spec checkout must equal ${SPEC_SHA}`);
const validator = assertNoLinkPath(path.join(specRoot, pin.validator), "file");
const release = assertNoLinkPath(path.join(releaseDir, "release.json"), "file");
const reports = ["conformance-interface.json", "conformance-release.json", "conformance-sidecar.json"]
  .map((name) => assertNoLinkPath(path.join(releaseDir, name), "file"));
for (const args of [["release", release], ["conformance", ...reports, "--release", release]]) {
  const result = spawnSync(process.execPath, [validator, ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`soksak-spec validator rejected release:\n${result.stderr}`);
  process.stdout.write(result.stdout);
}
