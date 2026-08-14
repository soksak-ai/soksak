// release.* — thin core commands that orchestrate the SINGLE-SOURCE release logic
// (packages/plugin-spec/release-template/) via the daemon_run_once spawn bridge. Zero release
// algorithm lives here: the handlers build a shell command (releaseOrchestration.ts, pure/testable),
// spawn it, and interpret the exit code + the --emit-summary line. The .mjs enforce every invariant
// (checksum match, exact matrix, symlink bans, pinned-validator gate); these commands only wire them
// to the sok CLI / MCP.
//
// Boundary (design §3): soksak-spec owns CONTRACTS + LOGIC (.mjs); the core owns BEHAVIOR (these
// thin commands); each unit repo owns IDENTITY (unit.json/targets.json). specRoot is a checkout of
// soksak-ai/soksak-spec — for release.validate it MUST be the pinned checkout (drift guard), which
// validate-with-spec.mjs self-enforces against spec-validator.json.
import { invoke } from "../framework";
import { register } from "./registry";
import { tmsg } from "../i18n";
import {
  assertOk,
  buildBuildRequest,
  buildPublishScript,
  buildValidateRequest,
  findReleaseUrl,
  parseReleaseSummary,
  type DaemonResult,
} from "./releaseOrchestration";

const runDaemon = (
  root: string,
  cmd: string,
  timeoutSecs: number,
  env?: Record<string, string>,
): Promise<DaemonResult> => invoke<DaemonResult>("daemon_run_once", { root, cmd, timeoutSecs, env });

export function registerReleaseCatalog(): void {
  register("release.validate", {
    description:
      "Validate a built release directory (release.json + 3 conformance reports) against the pinned public soksak-spec validator. Read-only. specRoot MUST be a checkout of soksak-ai/soksak-spec at the pinned commit — validate-with-spec.mjs refuses any other checkout (the consumer-contract drift guard). Runs the single-source release-template logic; no algorithm lives in the command.",
    triggers: { ko: "릴리즈 검증 validate 발행 검증기" },
    params: {
      unitRoot: { type: "string", required: true, description: "The unit repo root (cwd for the script)" },
      specRoot: { type: "string", required: true, description: "Pinned soksak-ai/soksak-spec checkout root" },
      releaseDir: { type: "string", required: true, description: "Dir holding release.json + 3 conformance reports" },
    },
    returns: "{ ok, stdout }",
    message: () => tmsg("msg.release.validate"),
    examples: ['release.validate \'{"unitRoot":"…","specRoot":".pipeline","releaseDir":"dist-release"}\''],
    handler: async (p) => {
      const req = buildValidateRequest({
        unitRoot: String(p.unitRoot),
        specRoot: String(p.specRoot),
        releaseDir: String(p.releaseDir),
      });
      const stdout = assertOk("release.validate", await runDaemon(req.root, req.cmd, 120));
      return { ok: true, stdout };
    },
  });

  register("release.build", {
    description:
      "Build the owner release manifest (release.json) + 3 conformance reports for a unit from an artifacts dir holding exactly the 5-target archive set + their .sha256 sidecars. Runs the single-source release-template builder with --emit-summary and returns the parsed manifest + per-target digests. Every invariant (checksum match, exact matrix, version/tag lockstep) is enforced by the builder. Chain into release.validate.",
    triggers: { ko: "릴리즈 빌드 build 매니페스트 발행" },
    params: {
      unitRoot: { type: "string", required: true, description: "The unit repo root (cwd; holds Cargo.toml + release/)" },
      specRoot: { type: "string", required: true, description: "soksak-ai/soksak-spec checkout providing the release-template" },
      commit: { type: "string", required: true, description: "Source commit — exact lowercase 40-char git SHA" },
      tag: { type: "string", required: true, description: "Release tag, must equal v<version>" },
      artifacts: { type: "string", required: true, description: "Dir with the 5 .tar.gz + 5 .sha256" },
      out: { type: "string", required: true, description: "Empty output dir for release.json + conformance reports" },
    },
    returns: "{ ok, releaseJson, manifestSha256, matrix }",
    message: (d) => tmsg("msg.release.build", { n: Array.isArray(d.matrix) ? d.matrix.length : 0 }),
    examples: ['release.build \'{"unitRoot":"…","specRoot":".pipeline","commit":"<40hex>","tag":"v0.0.1","artifacts":"dist","out":"dist-release"}\''],
    handler: async (p) => {
      const req = buildBuildRequest({
        unitRoot: String(p.unitRoot),
        specRoot: String(p.specRoot),
        commit: String(p.commit),
        tag: String(p.tag),
        artifacts: String(p.artifacts),
        out: String(p.out),
      });
      const r = await runDaemon(req.root, req.cmd, 180);
      assertOk("release.build", r);
      const summary = parseReleaseSummary(r.lines);
      return { ok: true, ...summary };
    },
  });

  register("release.publish", {
    description:
      "Cut the immutable GitHub release for a unit: require owner-enforced immutable releases, require EXACTLY the 5 platform archives + 5 checksums + release.json + 3 conformance reports, then create the release. IRREVERSIBLE — an immutable tag cannot be recut, only bumped. Requires confirm:true. gh auth comes from the token param (injected as GH_TOKEN into the child) or the operator's ambient gh. In CI the per-unit workflow's own gh step publishes; this command is for operator-with-gh use.",
    triggers: { ko: "릴리즈 발행 publish immutable 릴리즈 생성" },
    danger: "destructive",
    params: {
      repo: { type: "string", required: true, description: "owner/name, e.g. soksak-ai/soksak-sidecar-db-studio" },
      tag: { type: "string", required: true, description: "Release tag (v<version>)" },
      commit: { type: "string", required: true, description: "Target commit SHA for the release" },
      artifactsDir: { type: "string", required: true, description: "Dir with the 5 .tar.gz + 5 .sha256" },
      releaseDir: { type: "string", required: true, description: "Dir with release.json + 3 conformance reports" },
      token: { type: "string", required: false, description: "GitHub token; injected as GH_TOKEN (else ambient gh)" },
      confirm: { type: "boolean", required: true, description: "Must be true — this cuts an immutable, unrecuttable release" },
    },
    returns: "{ ok, url }",
    message: (d) =>
      typeof d.url === "string" && d.url
        ? tmsg("msg.release.publish.url", { url: d.url })
        : tmsg("msg.release.publish"),
    examples: ['release.publish \'{"repo":"soksak-ai/soksak-sidecar-db-studio","tag":"v0.0.1","commit":"<sha>","artifactsDir":"dist","releaseDir":"dist-release","confirm":true}\''],
    handler: async (p) => {
      if (p.confirm !== true) {
        throw new Error("release.publish cuts an immutable release — pass confirm:true to proceed");
      }
      const script = buildPublishScript({
        repo: String(p.repo),
        tag: String(p.tag),
        commit: String(p.commit),
        artifactsDir: String(p.artifactsDir),
        releaseDir: String(p.releaseDir),
      });
      const env = typeof p.token === "string" && p.token ? { GH_TOKEN: p.token } : undefined;
      const r = await runDaemon(String(p.artifactsDir), script, 300, env);
      assertOk("release.publish", r);
      return { ok: true, url: findReleaseUrl(r.lines) };
    },
  });

  register("plugin.new", {
    description:
      "Scaffold a new releasable plugin under the plugins workspace: package.json (soksakRelease block + private product boundary) + plugin.json (a content view + a wired <id>-root node + a hello command) + the tracked main.js entry, release-files.json (the declared shipped set + single-source discovery marker), src/conformance.test.ts (declared≡wired nodes), tsconfig.json, and the THIN release.yml/test.yml that check out the pinned soksak-spec and run the single-source plugin build-release/publish — it vendors ZERO release scripts. git-inits + registers it as a dev unit. name is unprefixed (id = soksak-plugin-<name>).",
    triggers: { ko: "플러그인 생성 새 플러그인 스캐폴드 scaffold" },
    params: {
      name: { type: "string", required: true, description: "Unprefixed name; id becomes soksak-plugin-<name>" },
    },
    returns: "{ ok, dir, id }",
    message: (d) => tmsg("msg.plugin.new", { id: typeof d.id === "string" ? d.id : "" }),
    examples: ['plugin.new \'{"name":"widget"}\''],
    handler: async (p) => {
      const r = await invoke<{ dir: string; dir_name: string }>("plugin_dev_new2", {
        name: String(p.name),
      });
      return { ok: true, dir: r.dir, id: r.dir_name };
    },
  });

  register("sidecar.new", {
    description:
      "Scaffold a new releasable service sidecar under the sidecars workspace: Cargo.toml + release/unit.json (identity), the STATIC targets.json + spec-validator.json pins (byte-verbatim), a serve skeleton (src/{main,lib,service}.rs + tests/wire.rs), stage.sh, and the THIN release.yml that references the single-source pipeline in soksak-spec — it vendors ZERO release scripts. git-inits + registers it as a dev unit. name is unprefixed (id = soksak-sidecar-<name>).",
    triggers: { ko: "사이드카 생성 새 사이드카 스캐폴드 scaffold" },
    params: {
      name: { type: "string", required: true, description: "Unprefixed name; id becomes soksak-sidecar-<name>" },
      interface: { type: "string", required: false, description: "Interface id (default soksak-spec-sidecar-<name>)" },
    },
    returns: "{ ok, dir, id }",
    message: (d) => tmsg("msg.sidecar.new", { id: typeof d.id === "string" ? d.id : "" }),
    examples: ['sidecar.new \'{"name":"widget"}\''],
    handler: async (p) => {
      const r = await invoke<{ dir: string; dir_name: string }>("sidecar_dev_new", {
        name: String(p.name),
        interface: p.interface != null ? String(p.interface) : undefined,
      });
      return { ok: true, dir: r.dir, id: r.dir_name };
    },
  });
}
