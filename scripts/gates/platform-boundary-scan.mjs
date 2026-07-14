import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXTRACTION_MANIFEST = "platform/extraction-manifest.json";

const PUBLIC_REPOSITORIES = new Set(["soksak-spec", "soksak-plugin-sdk"]);
const PUBLIC_RUST = new Set(["soksak-spec-service", "soksak-spec-socket"]);
const PUBLIC_UNITS = new Map([
  ["soksak-spec", new Set(["@soksak-ai/plugin-spec", "soksak-spec-service", "soksak-spec-socket"])],
  ["soksak-plugin-sdk", new Set(["@soksak-ai/plugin-api"])],
]);
const DOMAIN_CONTRACTS = new Set([
  "soksak-contract-browser",
  "soksak-contract-git",
  "soksak-contract-issue-board",
  "soksak-contract-prompt-store",
  "soksak-contract-terminal",
]);
const SOURCE_IGNORES = new Set(["dist", "node_modules", "target", ".DS_Store"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readManifest(root) {
  return readJson(resolve(root, EXTRACTION_MANIFEST));
}

function posix(path) {
  return path.split(sep).join("/");
}

function safeRelative(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).includes("..")
  );
}

function walkRegularFiles(root, at = root) {
  const out = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (SOURCE_IGNORES.has(entry.name)) continue;
    const path = join(at, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      out.push({ path: posix(relative(root, path)), kind: "symlink" });
    } else if (stat.isDirectory()) {
      out.push(...walkRegularFiles(root, path));
    } else if (stat.isFile()) {
      out.push({ path: posix(relative(root, path)), kind: "file" });
    } else {
      out.push({ path: posix(relative(root, path)), kind: "special" });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function packagePolicyViolations(pkg, role) {
  const errors = [];
  if (pkg.private !== true) errors.push(`${role}: private:true is required`);
  if (pkg.publishConfig !== undefined) errors.push(`${role}: publishConfig is forbidden`);
  if (pkg.scripts?.prepublishOnly !== undefined) {
    errors.push(`${role}: prepublishOnly is forbidden; GitHub artifacts use the boundary gate`);
  }
  for (const [field, deps] of Object.entries({
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
  })) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (name.startsWith("@soksak-ai/")) {
        errors.push(`${role}: first-party ${field}.${name} would resolve through a package registry (${spec})`);
      }
      if (String(spec).startsWith("workspace:")) {
        errors.push(`${role}: packed ${field}.${name} may not retain a workspace dependency`);
      }
    }
  }
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (name.startsWith("@soksak-ai/")) {
      errors.push(`${role}: first-party devDependencies.${name} belongs in the repository workspace root (${spec})`);
    }
    if (String(spec).startsWith("workspace:")) {
      errors.push(`${role}: public package source may not depend on workspace topology (${name}=${spec})`);
    }
  }
  return errors;
}

function validateInventory(root, unit, errors) {
  if (!safeRelative(unit.source) || !safeRelative(unit.destination)) {
    errors.push(`${unit.name}: source/destination must be safe declarative relative paths`);
    return;
  }
  const source = resolve(root, unit.source);
  if (!existsSync(source)) {
    errors.push(`${unit.name}: source does not exist: ${unit.source}`);
    return;
  }
  if (!Array.isArray(unit.files) || unit.files.length === 0) {
    errors.push(`${unit.name}: files inventory is required`);
    return;
  }
  const declared = [...unit.files];
  const normalized = [...new Set(declared)].sort();
  if (JSON.stringify(declared) !== JSON.stringify(normalized)) {
    errors.push(`${unit.name}: files inventory must be sorted and duplicate-free`);
  }
  for (const file of declared) {
    if (!safeRelative(file)) errors.push(`${unit.name}: unsafe inventory path: ${file}`);
  }
  const actual = walkRegularFiles(source);
  for (const entry of actual) {
    if (entry.kind !== "file") errors.push(`${unit.name}: ${entry.kind} is forbidden: ${entry.path}`);
  }
  const actualFiles = actual.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  if (JSON.stringify(normalized) !== JSON.stringify(actualFiles)) {
    const missing = actualFiles.filter((file) => !normalized.includes(file));
    const stale = normalized.filter((file) => !actualFiles.includes(file));
    if (missing.length) errors.push(`${unit.name}: undeclared source files: ${missing.join(", ")}`);
    if (stale.length) errors.push(`${unit.name}: missing declared files: ${stale.join(", ")}`);
  }
}

export function manifestViolations(root, manifest) {
  const errors = [];
  if (manifest.schema !== "ai.soksak/platform-extraction@1") {
    errors.push("extraction manifest: unsupported schema");
  }
  const repositories = Array.isArray(manifest.repositories) ? manifest.repositories : [];
  const names = new Set(repositories.map((repo) => repo.name));
  if (
    repositories.length !== PUBLIC_REPOSITORIES.size ||
    names.size !== PUBLIC_REPOSITORIES.size ||
    [...PUBLIC_REPOSITORIES].some((name) => !names.has(name))
  ) {
    errors.push(`extraction manifest: public repositories must be exactly ${[...PUBLIC_REPOSITORIES].join(", ")}`);
  }
  for (const repository of repositories) {
    const expected = PUBLIC_UNITS.get(repository.name);
    const declared = repository.units ?? [];
    const unitNames = new Set(declared.map((unit) => unit.name));
    if (
      !expected ||
      declared.length !== expected.size ||
      unitNames.size !== expected.size ||
      [...expected].some((name) => !unitNames.has(name))
    ) {
      errors.push(`${repository.name}: extraction units differ from the approved ownership boundary`);
    }
    if (repository.visibility !== "public") errors.push(`${repository.name}: visibility must be public`);
    if (repository.url !== `https://github.com/soksak-ai/${repository.name}`) {
      errors.push(`${repository.name}: repository URL must match its public owner`);
    }
  }

  const units = repositories.flatMap((repo) =>
    (Array.isArray(repo.units) ? repo.units : []).map((unit) => ({ ...unit, repository: repo.name })),
  );
  const rust = new Set(units.filter((unit) => unit.kind === "cargo").map((unit) => unit.name));
  if (rust.size !== PUBLIC_RUST.size || [...PUBLIC_RUST].some((name) => !rust.has(name))) {
    errors.push(`extraction manifest: public Rust crates must be exactly ${[...PUBLIC_RUST].join(", ")}`);
  }
  if (units.some((unit) => typeof unit.source === "string" && unit.source.includes("soksak-spec-pty"))) {
    errors.push("extraction manifest: PTY contract is private core state and must not be extracted");
  }
  const specRepo = repositories.find((repo) => repo.name === "soksak-spec");
  const cargoMembers = new Set(specRepo?.workspace?.cargoMembers ?? []);
  const expectedCargoMembers = new Set([
    "crates/soksak-spec-service",
    "crates/soksak-spec-socket",
  ]);
  if (
    cargoMembers.size !== expectedCargoMembers.size ||
    [...expectedCargoMembers].some((member) => !cargoMembers.has(member))
  ) {
    errors.push("extraction manifest: soksak-spec Cargo workspace must contain service/socket only");
  }
  for (const unit of units) validateInventory(root, unit, errors);

  const excluded = Array.isArray(manifest.excludedBoundaries) ? manifest.excludedBoundaries : [];
  const privatePty = excluded.some(
    (item) => item.kind === "private-core" && item.name === "soksak-spec-pty" && item.source === "src-tauri/crates/soksak-spec-pty",
  );
  if (!privatePty) errors.push("extraction manifest: soksak-spec-pty must be explicitly retained by private core");
  const domains = new Set(excluded.filter((item) => item.kind === "domain-contract").map((item) => item.name));
  if (domains.size !== DOMAIN_CONTRACTS.size || [...DOMAIN_CONTRACTS].some((name) => !domains.has(name))) {
    errors.push(`extraction manifest: domain contracts must remain independent: ${[...DOMAIN_CONTRACTS].join(", ")}`);
  }

  const spec = units.find((unit) => unit.name === "@soksak-ai/plugin-spec");
  const sdk = units.find((unit) => unit.name === "@soksak-ai/plugin-api");
  if (spec?.repository !== "soksak-spec" || sdk?.repository !== "soksak-plugin-sdk") {
    errors.push("extraction manifest: plugin spec and SDK must have separate repository ownership");
  }
  if (spec?.artifact !== "github-release-tarball+sha256" || sdk?.artifact !== "github-release-tarball+sha256") {
    errors.push("extraction manifest: Node artifacts must be immutable GitHub Release tarballs with SHA-256");
  }
  for (const unit of units.filter((item) => item.kind === "cargo")) {
    if (unit.artifact !== "git-full-commit") {
      errors.push(`${unit.name}: Rust source dependency must be pinned by a full Git commit`);
    }
  }
  const sdkRequirements = Array.isArray(sdk?.requires) ? sdk.requires : [];
  const sdkSpecRequirement = sdkRequirements.find((item) => item.name === "@soksak-ai/plugin-spec");
  if (
    sdkRequirements.length !== 1 ||
    sdkSpecRequirement?.mode !== "peer" ||
    sdkSpecRequirement?.pin !== "exact-github-release-tarball+integrity"
  ) {
    errors.push("extraction manifest: SDK must require the spec as one separately pinned peer artifact");
  }
  return errors;
}

export function scanPlatformBoundaries(root = REPO_ROOT) {
  const errors = [];
  const manifestPath = resolve(root, EXTRACTION_MANIFEST);
  if (!existsSync(manifestPath)) {
    errors.push(`missing declarative extraction manifest: ${EXTRACTION_MANIFEST}`);
  } else {
    errors.push(...manifestViolations(root, readJson(manifestPath)));
  }

  const spec = readJson(resolve(root, "packages/plugin-spec/package.json"));
  const sdk = readJson(resolve(root, "packages/plugin-api/package.json"));
  const rootPackage = readJson(resolve(root, "package.json"));
  const pnpmWorkspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  const pnpmLock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  if (!/^autoInstallPeers:\s*false$/m.test(pnpmWorkspace)) {
    errors.push("workspace: autoInstallPeers must be false; every first-party peer source is explicit");
  }
  if (/^\s{2}'@soksak-ai\/[a-z0-9-]+@\d/m.test(pnpmLock)) {
    errors.push("workspace: first-party package registry resolution is forbidden in pnpm-lock.yaml");
  }
  const platformBuild =
    "pnpm --filter @soksak-ai/plugin-spec build && pnpm --filter @soksak-ai/plugin-api build";
  if (rootPackage.scripts?.["build:platform"] !== platformBuild) {
    errors.push("workspace: build:platform must build spec before SDK from a clean checkout");
  }
  if (rootPackage.scripts?.prebuild !== "pnpm run build:platform") {
    errors.push("workspace: prebuild must materialize public platform contracts");
  }
  if (rootPackage.scripts?.pretest !== "pnpm run build:platform") {
    errors.push("workspace: pretest must materialize public platform contracts");
  }
  errors.push(...packagePolicyViolations(spec, "plugin spec"));
  errors.push(...packagePolicyViolations(sdk, "plugin SDK"));
  if (sdk.peerDependencies?.[spec.name] !== spec.version) {
    errors.push(`plugin SDK: peerDependencies.${spec.name} must exactly equal ${spec.version}`);
  }
  if (sdk.devDependencies?.[spec.name] !== undefined) {
    errors.push(`plugin SDK: ${spec.name} development pin belongs in the SDK repository workspace root`);
  }
  if (spec.repository?.url !== "git+https://github.com/soksak-ai/soksak-spec.git") {
    errors.push("plugin spec: repository must point to public soksak-spec");
  }
  if (sdk.repository?.url !== "git+https://github.com/soksak-ai/soksak-plugin-sdk.git") {
    errors.push("plugin SDK: repository must point to public soksak-plugin-sdk");
  }

  for (const crate of ["soksak-spec-service", "soksak-spec-socket"]) {
    const cargo = readFileSync(resolve(root, `src-tauri/crates/${crate}/Cargo.toml`), "utf8");
    if (!/^publish\s*=\s*false\s*$/m.test(cargo)) errors.push(`${crate}: publish = false is required`);
    if (!/^repository\s*=\s*"https:\/\/github\.com\/soksak-ai\/soksak-spec"\s*$/m.test(cargo)) {
      errors.push(`${crate}: repository must point to public soksak-spec`);
    }
    if (/soksak-spec-pty/.test(cargo)) errors.push(`${crate}: public Rust boundary may not depend on private PTY`);
  }
  const ptyCargo = readFileSync(resolve(root, "src-tauri/crates/soksak-spec-pty/Cargo.toml"), "utf8");
  if (!/^publish\s*=\s*false\s*$/m.test(ptyCargo)) errors.push("soksak-spec-pty: private core crate must be non-publishable");
  return errors;
}

export function stageRepository(root, repositoryName, output) {
  const errors = scanPlatformBoundaries(root);
  if (errors.length) throw new Error(errors.join("\n"));
  if (existsSync(output) && readdirSync(output).length > 0) {
    throw new Error(`refusing to stage into non-empty directory: ${output}`);
  }
  const repository = readManifest(root).repositories.find((item) => item.name === repositoryName);
  if (!repository) throw new Error(`unknown extraction repository: ${repositoryName}`);
  mkdirSync(output, { recursive: true });
  for (const unit of repository.units) {
    for (const file of unit.files) {
      const from = resolve(root, unit.source, file);
      const to = resolve(output, unit.destination, file);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { dereference: false, errorOnExist: true, force: false });
    }
  }
  const cargoMembers = repository.workspace?.cargoMembers ?? [];
  if (cargoMembers.length > 0) {
    writeFileSync(
      join(output, "Cargo.toml"),
      `[workspace]\nresolver = "2"\nmembers = [\n${cargoMembers.map((member) => `  "${member}",`).join("\n")}\n]\n`,
    );
  }
  const nodePackages = repository.workspace?.nodePackages ?? [];
  if (nodePackages.length > 0) {
    writeFileSync(
      join(output, "pnpm-workspace.yaml"),
      `packages:\n${nodePackages.map((item) => `  - "${item}"`).join("\n")}\nautoInstallPeers: false\n`,
    );
  }
  return output;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function onlyTarball(dir, needle) {
  const matches = readdirSync(dir).filter((name) => name.endsWith(".tgz") && name.includes(needle));
  if (matches.length !== 1) throw new Error(`expected one ${needle} tarball, found: ${matches.join(", ")}`);
  return resolve(dir, matches[0]);
}

export function verifyReleaseArtifacts(root = REPO_ROOT) {
  const staticErrors = scanPlatformBoundaries(root);
  if (staticErrors.length) throw new Error(staticErrors.join("\n"));

  const work = mkdtempSync(join(tmpdir(), "soksak-platform-artifacts-"));
  try {
    const extractedSpec = join(work, "soksak-spec");
    stageRepository(root, "soksak-spec", extractedSpec);
    const metadata = JSON.parse(
      run("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline"], {
        cwd: extractedSpec,
      }),
    );
    const cargoNames = metadata.packages.map((item) => item.name).sort();
    if (JSON.stringify(cargoNames) !== JSON.stringify([...PUBLIC_RUST].sort())) {
      throw new Error(`extracted Rust packages changed: ${cargoNames.join(", ")}`);
    }
    run("cargo", ["test", "--workspace", "--offline"], {
      cwd: extractedSpec,
      env: { CARGO_TARGET_DIR: join(work, "cargo-target") },
    });

    const artifacts = join(work, "artifacts");
    mkdirSync(artifacts);
    run("pnpm", ["--dir", "packages/plugin-spec", "run", "build"], { cwd: root });
    run("pnpm", ["--dir", "packages/plugin-api", "run", "build"], { cwd: root });
    run("pnpm", ["--filter", "@soksak-ai/plugin-spec", "pack", "--pack-destination", artifacts], { cwd: root });
    run("pnpm", ["--filter", "@soksak-ai/plugin-api", "pack", "--pack-destination", artifacts], { cwd: root });
    const specTar = onlyTarball(artifacts, "plugin-spec");
    const sdkTar = onlyTarball(artifacts, "plugin-api");

    const packedPackages = new Map();
    for (const tarball of [specTar, sdkTar]) {
      const listing = run("tar", ["-tvzf", tarball]);
      const nonRegular = listing.split("\n").filter((line) => line && !line.startsWith("-"));
      if (nonRegular.length) {
        throw new Error(`${tarball}: archive contains a link or non-regular entry: ${nonRegular.join("\n")}`);
      }
      const names = run("tar", ["-tzf", tarball]).split("\n").filter(Boolean);
      if (
        new Set(names).size !== names.length ||
        names.some((name) => name.startsWith("/") || name.split("/").includes(".."))
      ) {
        throw new Error(`${tarball}: archive contains duplicate or unsafe paths`);
      }
      const extract = join(work, `extract-${sha256(tarball).slice(0, 12)}`);
      mkdirSync(extract);
      run("tar", ["-xzf", tarball, "-C", extract]);
      const entries = walkRegularFiles(extract);
      const forbidden = entries.filter((entry) => entry.kind !== "file");
      if (forbidden.length) throw new Error(`${tarball}: non-regular entries: ${JSON.stringify(forbidden)}`);
      const packed = readJson(join(extract, "package/package.json"));
      packedPackages.set(packed.name, packed);
      const policy = packagePolicyViolations(packed, packed.name);
      if (policy.length) throw new Error(policy.join("\n"));
    }
    const packedSpec = packedPackages.get("@soksak-ai/plugin-spec");
    const packedSdk = packedPackages.get("@soksak-ai/plugin-api");
    if (packedSdk?.peerDependencies?.[packedSpec?.name] !== packedSpec?.version) {
      throw new Error("packed SDK must require the exact separately installed spec peer");
    }
    if (packedSdk?.dependencies?.[packedSpec?.name] !== undefined) {
      throw new Error("packed SDK must not bundle or registry-resolve the platform spec");
    }

    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "soksak-platform-clean-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@soksak-ai/plugin-api": `file:${sdkTar}`,
          "@soksak-ai/plugin-spec": `file:${specTar}`,
        },
      }, null, 2)}\n`,
    );
    const emptyCache = join(work, "empty-npm-cache");
    mkdirSync(emptyCache);
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumer,
      env: { npm_config_cache: emptyCache, npm_config_registry: "http://127.0.0.1:9" },
    });
    writeFileSync(
      join(consumer, "smoke.mjs"),
      'import { SPEC_VERSION, parseManifest } from "@soksak-ai/plugin-spec";\n' +
        'if (SPEC_VERSION !== "soksak-spec-plugin@1") throw new Error(`unexpected spec ${SPEC_VERSION}`);\n' +
        'if (typeof parseManifest !== "function") throw new Error("validator missing");\n' +
        'await import("@soksak-ai/plugin-api");\n',
    );
    run(process.execPath, ["smoke.mjs"], { cwd: consumer });
    writeFileSync(
      join(consumer, "smoke.ts"),
      'import type { Plugin } from "@soksak-ai/plugin-api";\n' +
        'import type { PluginManifest } from "@soksak-ai/plugin-spec";\n' +
        'declare const plugin: Plugin; declare const manifest: PluginManifest;\n' +
        'void plugin; void manifest;\n',
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", lib: ["ES2022", "DOM"] }, include: ["smoke.ts"] }, null, 2)}\n`,
    );
    run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: consumer });

    const lock = readJson(join(consumer, "package-lock.json"));
    for (const name of ["@soksak-ai/plugin-api", "@soksak-ai/plugin-spec"]) {
      const entry = lock.packages?.[`node_modules/${name}`];
      if (!entry?.resolved?.startsWith("file:") || typeof entry.integrity !== "string") {
        throw new Error(`${name}: clean fixture must lock an exact local tarball and integrity`);
      }
    }
    return {
      spec: { name: specTar.split(sep).at(-1), sha256: sha256(specTar) },
      sdk: { name: sdkTar.split(sep).at(-1), sha256: sha256(sdkTar) },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const errors = scanPlatformBoundaries(REPO_ROOT);
  if (errors.length) {
    console.error(errors.map((error) => `✗ ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--artifacts")) {
    const artifacts = verifyReleaseArtifacts(REPO_ROOT);
    console.log(`✓ platform artifacts: spec sha256=${artifacts.spec.sha256} sdk sha256=${artifacts.sdk.sha256}`);
  } else if (process.argv.includes("--stage")) {
    const at = process.argv.indexOf("--stage");
    const repository = process.argv[at + 1];
    const output = process.argv[at + 2];
    if (!repository || !output) throw new Error("usage: --stage <repository> <empty-output-directory>");
    stageRepository(REPO_ROOT, repository, resolve(output));
    console.log(`✓ staged ${repository} at ${resolve(output)}`);
  } else {
    console.log("✓ platform boundary");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
