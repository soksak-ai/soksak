// Pure orchestration for the release.* commands — shell-command construction, output parsing, exit
// interpretation. Imports NOTHING (no registry, no tauri), so it is unit-testable in isolation and
// carries zero release algorithm (that lives single-sourced in packages/plugin-spec/release-template).
// catalogRelease.ts wires these to `register` + the daemon_run_once spawn bridge.

/** POSIX single-quote a shell word so paths with spaces/metacharacters cannot break out. */
export function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

const SUMMARY_MARK = "@@RELEASE_SUMMARY@@ ";

export interface DaemonResult {
  code: number | null;
  lines: string[];
}

/** The daemon_run_once request for release.validate (runs the pinned validator twice). */
export function buildValidateRequest(p: { unitRoot: string; specRoot: string; releaseDir: string }): {
  root: string;
  cmd: string;
} {
  const script = `${p.specRoot}/packages/plugin-spec/release-template/sidecar/validate-with-spec.mjs`;
  // root = unitRoot: the daemon runs the script FROM the unit, so the canonical script discovers this
  // unit's spec-validator.json pin by its marker (no --unit-root argument, no cwd guessing).
  return {
    root: p.unitRoot,
    cmd: `node ${shq(script)} --spec-root ${shq(p.specRoot)} --release-dir ${shq(p.releaseDir)}`,
  };
}

/** The daemon_run_once request for release.build (emits release.json + 3 conformance + summary). */
export function buildBuildRequest(p: {
  unitRoot: string;
  specRoot: string;
  commit: string;
  tag: string;
  artifacts: string;
  out: string;
}): { root: string; cmd: string } {
  const script = `${p.specRoot}/packages/plugin-spec/release-template/sidecar/build-release.mjs`;
  // root = unitRoot: the daemon runs FROM the unit, so the canonical builder discovers this unit's
  // Cargo.toml/release/*.json by its marker (no --unit-root argument, no cwd guessing).
  return {
    root: p.unitRoot,
    cmd:
      `node ${shq(script)} --commit ${shq(p.commit)} --tag ${shq(p.tag)} ` +
      `--artifacts ${shq(p.artifacts)} --out ${shq(p.out)} --emit-summary`,
  };
}

/** Pull the one @@RELEASE_SUMMARY@@ line out of captured output and parse it. */
export function parseReleaseSummary(lines: string[]): {
  releaseJson: unknown;
  manifestSha256: string;
  matrix: Array<{ target: string; url: string; sha256: string; format: string; entrypoint: unknown }>;
} {
  const line = lines.find((l) => l.startsWith(SUMMARY_MARK));
  if (!line) throw new Error("release.build produced no @@RELEASE_SUMMARY@@ line");
  return JSON.parse(line.slice(SUMMARY_MARK.length));
}

/** Fail unless the child exited 0; the captured output is the failure evidence. */
export function assertOk(where: string, r: DaemonResult): string {
  const output = r.lines.join("\n");
  if (r.code !== 0) throw new Error(`${where} failed (exit ${r.code}):\n${output}`);
  return output;
}

/**
 * The publish shell script (mirrors the per-unit release.yml publish gate): require owner-enforced
 * immutable releases, require EXACTLY the 5 archives + 5 checksums + release.json + 3 conformance
 * reports, then cut the immutable release. Irreversible — the command gates this behind confirm+token.
 * gh auth comes from GH_TOKEN in the child env (never interpolated into the script).
 */
export function buildPublishScript(p: {
  repo: string;
  tag: string;
  commit: string;
  artifactsDir: string;
  releaseDir: string;
}): string {
  const api = shq(`repos/${p.repo}/immutable-releases`);
  const dirs = `${shq(p.artifactsDir)} ${shq(p.releaseDir)}`;
  return [
    "set -eu",
    `enforced="$(gh api ${api} --jq '.enabled and .enforced_by_owner')"`,
    `test "$enforced" = "true" || { echo "owner-enforced immutable releases must be enabled before tagging" >&2; exit 1; }`,
    `assets="$(find ${dirs} -type f \\( -name '*.tar.gz' -o -name '*.tar.gz.sha256' -o -name '*.json' \\) | sort)"`,
    `test "$(printf '%s\\n' "$assets" | grep -c '\\.tar\\.gz$')" -eq 5 || { echo "expected 5 platform archives" >&2; exit 1; }`,
    `test "$(printf '%s\\n' "$assets" | grep -c '\\.tar\\.gz\\.sha256$')" -eq 5 || { echo "expected 5 archive checksums" >&2; exit 1; }`,
    `test "$(printf '%s\\n' "$assets" | grep -c '/release\\.json$')" -eq 1 || { echo "expected the owner release manifest" >&2; exit 1; }`,
    `test "$(printf '%s\\n' "$assets" | grep -c '/conformance-[a-z]*\\.json$')" -eq 3 || { echo "expected 3 conformance reports" >&2; exit 1; }`,
    `gh release create ${shq(p.tag)} --repo ${shq(p.repo)} --target ${shq(p.commit)} --title ${shq(p.tag)} --generate-notes $assets`,
  ].join("\n");
}

/** The GitHub release URL `gh release create` prints on success (the last matching line). */
export function findReleaseUrl(lines: string[]): string | null {
  const url = [...lines].reverse().find((l) => /^https:\/\/github\.com\/\S+\/releases\/tag\/\S+$/.test(l.trim()));
  return url ? url.trim() : null;
}
