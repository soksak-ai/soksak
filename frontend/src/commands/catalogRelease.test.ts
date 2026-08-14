import { describe, it, expect } from "vitest";
import {
  shq,
  buildValidateRequest,
  buildBuildRequest,
  buildPublishScript,
  findReleaseUrl,
  parseReleaseSummary,
  assertOk,
} from "./releaseOrchestration";

describe("release.* orchestration (pure — the LOGIC lives in the single-source .mjs)", () => {
  it("shq POSIX-quotes words and escapes embedded single quotes (no shell breakout)", () => {
    expect(shq("/a/b")).toBe("'/a/b'");
    expect(shq("/a b/c")).toBe("'/a b/c'");
    // it's  ->  'it'\''s'
    expect(shq("it's")).toBe("'it'\\''s'");
    // a path trying to break out stays one quoted word
    expect(shq("/x'; rm -rf /")).toBe("'/x'\\''; rm -rf /'");
  });

  it("buildValidateRequest targets the pinned validator under specRoot, cwd = unitRoot", () => {
    const r = buildValidateRequest({ unitRoot: "/u", specRoot: "/spec", releaseDir: "/rel" });
    expect(r.root).toBe("/u");
    expect(r.cmd).toBe(
      "node '/spec/packages/plugin-spec/release-template/sidecar/validate-with-spec.mjs' --spec-root '/spec' --release-dir '/rel'",
    );
  });

  it("buildBuildRequest passes --emit-summary and quotes every argument", () => {
    const commit = "a".repeat(40);
    const r = buildBuildRequest({ unitRoot: "/u", specRoot: "/spec", commit, tag: "v0.0.1", artifacts: "/art", out: "/out" });
    expect(r.root).toBe("/u");
    expect(r.cmd).toBe(
      `node '/spec/packages/plugin-spec/release-template/sidecar/build-release.mjs' --commit '${commit}' --tag 'v0.0.1' --artifacts '/art' --out '/out' --emit-summary`,
    );
  });

  it("parseReleaseSummary extracts and parses the sentinel line, ignoring other output", () => {
    const summary = {
      releaseJson: { id: "soksak-sidecar-x", version: "0.0.1" },
      manifestSha256: "a".repeat(64),
      matrix: [{ target: "aarch64-apple-darwin", url: "u", sha256: "s", format: "tar.gz", entrypoint: {} }],
    };
    const lines = ["profile noise", `@@RELEASE_SUMMARY@@ ${JSON.stringify(summary)}`, "trailer"];
    expect(parseReleaseSummary(lines)).toEqual(summary);
  });

  it("parseReleaseSummary throws when the builder emitted no summary line", () => {
    expect(() => parseReleaseSummary(["no summary here"])).toThrow(/no @@RELEASE_SUMMARY@@/);
  });

  it("assertOk throws with the captured output on a nonzero exit, returns it on success", () => {
    expect(() => assertOk("release.build", { code: 1, lines: ["boom", "detail"] })).toThrow(
      "release.build failed (exit 1):\nboom\ndetail",
    );
    expect(() => assertOk("release.validate", { code: null, lines: ["killed"] })).toThrow(/exit null/);
    expect(assertOk("release.validate", { code: 0, lines: ["all good"] })).toBe("all good");
  });

  it("buildPublishScript gates immutability + the exact asset set before the irreversible create", () => {
    const commit = "c".repeat(40);
    const s = buildPublishScript({
      repo: "soksak-ai/soksak-sidecar-db-studio",
      tag: "v0.0.1",
      commit,
      artifactsDir: "/dist",
      releaseDir: "/rel",
    });
    expect(s).toContain("gh api 'repos/soksak-ai/soksak-sidecar-db-studio/immutable-releases' --jq '.enabled and .enforced_by_owner'");
    expect(s).toContain(`test "$enforced" = "true"`);
    expect(s).toContain("grep -c '\\.tar\\.gz$')\" -eq 5");
    expect(s).toContain("grep -c '\\.tar\\.gz\\.sha256$')\" -eq 5");
    expect(s).toContain("grep -c '/release\\.json$')\" -eq 1");
    expect(s).toContain("grep -c '/conformance-[a-z]*\\.json$')\" -eq 3");
    expect(s).toContain("find '/dist' '/rel' -type f");
    expect(s).toContain(`gh release create 'v0.0.1' --repo 'soksak-ai/soksak-sidecar-db-studio' --target '${commit}' --title 'v0.0.1' --generate-notes $assets`);
    // the token is env-injected by the handler, never interpolated into the script text
    expect(s).not.toContain("GH_TOKEN");
  });

  it("findReleaseUrl returns the release URL gh prints, else null", () => {
    const url = "https://github.com/soksak-ai/soksak-sidecar-db-studio/releases/tag/v0.0.1";
    expect(findReleaseUrl(["noise", url])).toBe(url);
    expect(findReleaseUrl(["no url here"])).toBeNull();
  });
});
