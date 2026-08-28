import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const requireFrontend = createRequire(new URL("../frontend/package.json", import.meta.url));
const { STRICT_SEMVER_RE } = requireFrontend("@soksak/soksak-spec");

const root = join(import.meta.dirname, "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const pkg = JSON.parse(read("frontend/package.json"));
const lockfile = read("frontend/pnpm-lock.yaml");
const makefile = read("Makefile");
const scoped = (name) => /^@soksak(-ai)?\//.test(name);

const scopedDependencies = () => {
  const found = [];
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) if (scoped(name)) found.push([section, name, spec]);
  }
  return found;
};

test("frontend/package.json declares every @soksak dependency by exact version", () => {
  const found = scopedDependencies();
  assert.deepEqual(found.map(([, name]) => name), ["@soksak/soksak-spec"]);
  for (const [section, name, spec] of found) assert.match(spec, STRICT_SEMVER_RE, `${section}.${name}`);
});

test("frontend/pnpm-lock.yaml resolves @soksak packages by integrity without a tarball URL", () => {
  assert.equal(/github\.com\/soksak-ai\//.test(lockfile), false, "lockfile pins a GitHub tarball");
  const resolutions = new Map(
    [...lockfile.matchAll(/^  '(@soksak(?:-ai)?\/[^@']+@[^'(]+)':\n    resolution: \{([^}]*)\}/gm)].map(([, key, resolution]) => [key, resolution]),
  );
  assert.deepEqual([...resolutions.keys()].sort(), scopedDependencies().map(([, name, spec]) => `${name}@${spec}`).sort());
  for (const [key, resolution] of resolutions) assert.match(resolution, /^integrity: sha512-[A-Za-z0-9+/=]+$/, key);
  for (const [, name, spec] of scopedDependencies()) {
    assert.match(lockfile, new RegExp(`^      '${name}':\\n        specifier: ${spec.replaceAll(".", "[.]")}\\n`, "m"), name);
  }
});

const makeVariable = (name) => {
  const match = makefile.match(new RegExp(`^${name} = (.+)$`, "m"));
  assert.ok(match, name);
  return match[1];
};
// A parent make exports REGISTRY and MAKEFLAGS (which carries its command-line variables) to recipe
// processes; a bare PATH keeps every such channel out of the sub-make.
const run = (args, env = {}) =>
  spawnSync("make", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const refused = (result, message) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /TOOLCHAIN_READY|task:/);
};

test("Makefile forwards a command-line REGISTRY as the scoped registry flags to every pnpm caller", () => {
  assert.equal(
    makeVariable("registry_flags"),
    "--@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0",
  );
  assert.equal(makeVariable("registry_arguments"), "$(if $(findstring command line,$(origin REGISTRY)),$(registry_flags))");
  assert.match(makefile, /^guard:$/m);
  assert.match(makefile, /^prepare: guard preflight\n\t@scripts\/ci\/prepare-frontend-dependencies\.sh \$\(registry_arguments\)$/m);
  assert.match(makefile, /^verify: guard\n\t@go tool wails3 task verify PNPM_FLAGS='\$\(registry_arguments\)'$/m);
  assert.match(makefile, /^build: guard require-target$/m);
  const releaseScripts = makefile.match(/scripts\/ci\/(?:darwin-release|linux-release|windows-build)\.sh \S+ \$\(registry_arguments\)/g) ?? [];
  assert.equal(releaseScripts.length, 5, "every build script call forwards the registry flags");
  assert.match(makefile, /node -p '[^']*dependencies[^']*devDependencies[^']*peerDependencies/);
  refused(run(["prepare", "REGISTRY=localhost:4873"]), /REGISTRY must be an absolute URL/);
  refused(run(["prepare", "REGISTRY="]), /REGISTRY must be an absolute URL/);
  refused(run(["prepare"], { REGISTRY: "http://127.0.0.1:4873/" }), /REGISTRY from the environment is refused/);
  refused(run(["build", "TARGET=aarch64-apple-darwin"], { REGISTRY: "http://127.0.0.1:4873/" }), /REGISTRY from the environment is refused/);
  refused(run(["verify"], { REGISTRY: "http://127.0.0.1:4873/" }), /REGISTRY from the environment is refused/);
});

test("Makefile requires REGISTRY on the command line because the frontend depends on @soksak", () => {
  const dependency = /REGISTRY required: this package depends on @soksak\/soksak-spec/;
  refused(run(["prepare"]), dependency);
  refused(run(["build", "TARGET=aarch64-apple-darwin"]), dependency);
  refused(run(["verify"]), dependency);
});

// pnpm 11 compares the settings recorded by the install before every script run and reinstalls
// on any difference; every pnpm invocation therefore repeats the install environment and flags.
test("Taskfiles and CI scripts run pnpm with the forwarded flags and the install environment", () => {
  const taskfile = read("Taskfile.yml");
  assert.match(taskfile, /^  PNPM_FLAGS: '\{\{\.PNPM_FLAGS \| default ""\}\}'$/m);
  assert.match(taskfile, /^      - scripts\/ci\/prepare-frontend-dependencies\.sh \{\{\.PNPM_FLAGS\}\}$/m);
  assert.match(taskfile, /^      - task: verify:build-input$/m);
  assert.match(taskfile, /^      - node --test scripts\/check-registry-install\.mjs$/m);
  for (const script of ["typecheck", "test"]) {
    assert.match(taskfile, new RegExp(`^      - "CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 \\{\\{\\.PACKAGE_MANAGER\\}\\} \\{\\{\\.PNPM_FLAGS\\}\\} ${script}"$`, "m"), script);
  }
  const build = read("build/Taskfile.yml");
  assert.match(build, /^      - CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm \{\{\.PNPM_FLAGS\}\} install --frozen-lockfile$/m);
  assert.match(build, /^      - CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm \{\{\.PNPM_FLAGS\}\} run \{\{\.BUILD_COMMAND\}\}$/m);
  const prepare = read("scripts/ci/prepare-frontend-dependencies.sh");
  assert.match(prepare, /"\$0" --locked "\$@"/);
  assert.match(prepare, /CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm "\$@" install --frozen-lockfile/);
  const frontendBuild = read("scripts/ci/frontend-build.sh");
  for (const command of ["install --frozen-lockfile", "typecheck", "build"]) {
    assert.match(frontendBuild, new RegExp(`^  pnpm "\\$@" ${command}$`, "m"), command);
  }
  assert.match(frontendBuild, /\/bin\/sh -c 'pnpm "\$@" install --frozen-lockfile && pnpm "\$@" typecheck && pnpm "\$@" build' sh "\$@"/);
  const files = ["Taskfile.yml", "build/Taskfile.yml", ...readdirSync(join(root, "scripts/ci")).map((name) => `scripts/ci/${name}`)];
  for (const name of files) {
    for (const line of read(name).split("\n")) {
      if (/^\s*#/.test(line)) continue;
      assert.doesNotMatch(line, /\bpnpm\s+(?:--dir \S+\s+)?(?:install|run|build|typecheck|test)\b/, `${name}: ${line.trim()}`);
    }
  }
});

test("documentation shows REGISTRY on every make command line", () => {
  for (const name of ["README.md", "README.ko.md"]) {
    const readme = read(name);
    assert.ok(readme.includes("make verify REGISTRY=http://host:port/"), name);
    assert.ok(readme.includes("REGISTRY required: this package depends on @soksak-ai/"), name);
  }
  const docs = readdirSync(join(root, "docs/tech")).filter((name) => name.endsWith(".md")).map((name) => `docs/tech/${name}`);
  for (const name of ["README.md", "README.ko.md", ...docs]) {
    const text = read(name);
    for (const [mention] of text.matchAll(/`make (?:prepare|verify|build)\b[^`]*`/g)) assert.match(mention, /REGISTRY=/, `${name}: ${mention}`);
    for (const [line] of text.matchAll(/^make (?:prepare|verify|build)\b.*$/gm)) assert.match(line, /REGISTRY=/, `${name}: ${line}`);
  }
  const workflow = read(".github/workflows/multiplatform-system.yml");
  for (const [line] of workflow.matchAll(/^.*make build\b.*$/gm)) assert.match(line, /REGISTRY=https:\/\/registry\.npmjs\.org\//, line.trim());
});
