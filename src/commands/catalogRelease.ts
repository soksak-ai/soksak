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
import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";
import {
  assertOk,
  buildBuildRequest,
  buildValidateRequest,
  parseReleaseSummary,
  type DaemonResult,
} from "./releaseOrchestration";

const runDaemon = (root: string, cmd: string, timeoutSecs: number): Promise<DaemonResult> =>
  invoke<DaemonResult>("daemon_run_once", { root, cmd, timeoutSecs });

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
}
