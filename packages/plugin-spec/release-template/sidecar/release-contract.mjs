import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseUnitMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("release metadata must be an object");
  const keys = Object.keys(raw).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["id", "interface", "releaseTag", "repository", "version"])) throw new Error("release metadata keys are closed");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(raw.id) || !SEMVER.test(raw.version)) throw new Error("invalid release identity");
  if (raw.releaseTag !== `v${raw.version}`) throw new Error("releaseTag must derive from version");
  if (raw.repository !== `https://github.com/soksak-ai/${raw.id}`) throw new Error("repository must match the unit id");
  if (
    !raw.interface || typeof raw.interface !== "object" || Array.isArray(raw.interface) ||
    JSON.stringify(Object.keys(raw.interface).sort()) !== JSON.stringify(["id", "version"]) ||
    !/^soksak-spec-sidecar-[a-z0-9][a-z0-9-]*$/.test(raw.interface.id) ||
    raw.interface.version !== raw.version
  ) throw new Error("interface provider must match the unit version");
  return Object.freeze({ ...raw, interface: Object.freeze({ ...raw.interface }) });
}

export function readUnitMetadata(filename = path.join(ROOT, "release", "unit.json")) {
  return parseUnitMetadata(JSON.parse(fs.readFileSync(filename, "utf8")));
}

export const UNIT = readUnitMetadata();
export const ID = UNIT.id;
export const VERSION = UNIT.version;
export const TAG = UNIT.releaseTag;
export const REPOSITORY = UNIT.repository;
export const INTERFACE = UNIT.interface;
export const SPEC_SHA = JSON.parse(fs.readFileSync(path.join(ROOT, "validation", "spec-validator.json"), "utf8")).commit;
export const RELEASE_SPEC = "soksak-spec-release@0.0.1";
export const SIDECAR_SPEC = "soksak-spec-sidecar@0.0.1";
export const CONFORMANCE_SPEC = "soksak-spec-conformance@0.0.1";

export function releaseAssetName(target, unit = UNIT) {
  return `${unit.id}-${unit.version}-${target}.tar.gz`;
}

export function releaseIdentity(commit, unit = UNIT) {
  assertCommit(commit);
  return {
    spec: RELEASE_SPEC,
    kind: "sidecar",
    id: unit.id,
    version: unit.version,
    source: { repository: unit.repository, commit },
    releaseTag: unit.releaseTag,
  };
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function parseOptions(argv, required) {
  const wanted = new Set(required);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("options must be --name value pairs");
    const name = flag.slice(2);
    if (!wanted.has(name)) throw new Error(`unknown option: ${flag}`);
    if (values.has(name)) throw new Error(`duplicate option: ${flag}`);
    values.set(name, value);
  }
  for (const name of required) {
    if (!values.has(name) || values.get(name) === "") throw new Error(`--${name} is required`);
  }
  return Object.fromEntries(values);
}

export function assertCommit(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("source commit must be an exact lowercase 40-character Git SHA");
}

export function assertTag(tag) {
  if (tag !== TAG) throw new Error(`release tag must equal ${TAG}`);
}

export function readTargetMatrix() {
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, "release", "targets.json"), "utf8"));
  if (!Array.isArray(matrix) || matrix.length !== 5) throw new Error("release matrix must contain exactly five targets");
  let previous = "";
  const seen = new Set();
  for (const [index, entry] of matrix.entries()) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["runner", "target"])
    ) throw new Error(`release target ${index} must contain only runner and target`);
    if (!/^(?:aarch64|x86_64)-(?:apple-darwin|pc-windows-msvc|unknown-linux-gnu)$/.test(entry.target)) {
      throw new Error(`unsupported release target: ${entry.target}`);
    }
    if (typeof entry.runner !== "string" || entry.runner.length === 0) throw new Error(`runner required for ${entry.target}`);
    if (seen.has(entry.target)) throw new Error(`duplicate release target: ${entry.target}`);
    if (previous && Buffer.compare(Buffer.from(previous), Buffer.from(entry.target)) >= 0) {
      throw new Error("release targets must be bytewise sorted");
    }
    previous = entry.target;
    seen.add(entry.target);
  }
  return matrix;
}

export function targetEntry(target) {
  const entry = readTargetMatrix().find((candidate) => candidate.target === target);
  if (!entry) throw new Error(`target is not declared: ${target}`);
  return entry;
}

export function binaryName(target) {
  targetEntry(target);
  return `${ID}${target.includes("windows") ? ".exe" : ""}`;
}

export function assertNoLinkPath(input, kind) {
  const absolute = path.resolve(input);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${cursor}`);
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${absolute}`);
  if (kind === "file" && !stat.isFile()) throw new Error(`regular file required: ${absolute}`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`regular directory required: ${absolute}`);
  return absolute;
}

export function readRegularFile(input) {
  const absolute = assertNoLinkPath(input, "file");
  const before = fs.lstatSync(absolute);
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const after = fs.fstatSync(fd);
    // Match the opened handle to the lstat'd file by inode only. On Windows,
    // lstat reports dev 0 while fstat reports the real volume id, so a dev
    // comparison always fails there; the inode is stable across lstat/fstat on
    // every OS and still changes when the file is swapped under the path.
    if (!after.isFile() || before.ino !== after.ino) {
      throw new Error(`regular file changed while opening: ${absolute}`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function ensureEmptyDirectory(input) {
  const absolute = path.resolve(input);
  if (fs.existsSync(absolute)) {
    assertNoLinkPath(absolute, "directory");
    if (fs.readdirSync(absolute).length !== 0) throw new Error(`output directory must be empty: ${absolute}`);
  } else {
    fs.mkdirSync(absolute, { recursive: true });
    assertNoLinkPath(absolute, "directory");
  }
  return absolute;
}

export function writeRegularFile(filename, bytes, mode = 0o644) {
  const absolute = path.resolve(filename);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) throw new Error(`regular output file required: ${absolute}`);
  const fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    fs.writeFileSync(fd, bytes);
    if (process.platform !== "win32") fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function assertBaseline() {
  // This unit does not link soksak-spec; the pinned public validator judges its
  // release documents from the outside (validation/spec-validator.json).
  const cargo = fs.readFileSync(path.join(ROOT, "Cargo.toml"), "utf8");
  if (!cargo.includes(`version = "${VERSION}"`) || !cargo.includes("publish = false")) throw new Error("Cargo package must match private release metadata");
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "validation", "spec-validator.json"), "utf8"));
  if (pin.repository !== "https://github.com/soksak-ai/soksak-spec" || pin.commit !== SPEC_SHA || pin.validator !== "packages/plugin-spec/bin/validate.mjs") {
    throw new Error("validator pin does not match the public specification source");
  }
}
