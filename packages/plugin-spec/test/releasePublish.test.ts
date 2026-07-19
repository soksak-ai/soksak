// The canonical publish-release.mjs cuts an owner-immutable GitHub release. Publishing a draft under
// immutable enforcement seals the release ASYNCHRONOUSLY on GitHub's side — the release object read
// immediately after PATCH draft:false transiently reports a mid-seal identity (blank name, not-yet
// immutable) before it settles. A single post-publish read races that seal and fails a real, complete
// publication. These pin the contract: publication verification polls the seal to a coherent terminal
// state and only then returns published; a release that never seals fails closed.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { publishImmutableRelease } from "../release-template/publish-release.mjs";

const REPOSITORY = "soksak-ai/soksak-plugin-example";
const COMMIT = "a".repeat(40);
const TAG = "v0.0.1";

function makeAsset(name: string, content: string, contentType: string) {
  const bytes = Buffer.from(content);
  return {
    name,
    bytes,
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    contentType,
  };
}

const ASSETS = [
  makeAsset("soksak-plugin-example-0.0.1-any.tgz", "archive-bytes", "application/gzip"),
  makeAsset("release.json", '{"kind":"plugin"}', "application/json"),
  makeAsset("conformance-plugin.json", '{"ok":true}', "application/json"),
];

// A GitHub double that models owner-immutable publication. `sealAfter` is how many post-publish reads
// return the transient mid-seal projection before the release settles — the async seal the real API has.
class FakeGitHub {
  tags = new Map<string, string>();
  release: Record<string, unknown> | null = null;
  remoteAssets: Array<Record<string, unknown>> = [];
  published = false;
  postPublishReads = 0;
  constructor(private readonly sealAfter: number) {}

  async assertImmutable() {
    return { enabled: true, enforced_by_owner: true };
  }
  async getTagCommit(tag: string) {
    return this.tags.get(tag) ?? null;
  }
  async createTag(tag: string, commit: string) {
    this.tags.set(tag, commit);
  }
  async createDraft(tag: string, commit: string, prerelease: boolean) {
    this.release = { id: 42, tag_name: tag, name: tag, draft: true, prerelease, immutable: false };
    return { ...this.release };
  }
  async getRelease(tag: string) {
    if (!this.release || this.release.tag_name !== tag) return null;
    if (!this.published) return { ...this.release };
    this.postPublishReads += 1;
    if (this.postPublishReads <= this.sealAfter) {
      // Mid-seal: GitHub blanks the name and has not stamped immutable yet.
      return { ...this.release, draft: false, name: "", immutable: false };
    }
    return { ...this.release, draft: false, name: tag, immutable: true };
  }
  async listAssets() {
    return this.remoteAssets.map((asset) => ({ ...asset }));
  }
  async uploadAsset(_release: unknown, asset: { name: string; size: number; digest: string }) {
    const uploaded = { name: asset.name, state: "uploaded", size: asset.size, digest: asset.digest };
    this.remoteAssets.push(uploaded);
    return { ...uploaded };
  }
  async publishDraft(_release: unknown, prerelease: boolean) {
    this.published = true;
    this.release = { ...(this.release as Record<string, unknown>), draft: false, prerelease };
    return { ...this.release };
  }
}

const noSleep = async () => {};

function run(api: FakeGitHub) {
  return publishImmutableRelease({
    repository: REPOSITORY,
    commit: COMMIT,
    tag: TAG,
    prerelease: false,
    assets: ASSETS,
    api,
    settleAttempts: 6,
    sleep: noSleep,
  });
}

describe("publishImmutableRelease — owner-immutable publication settles the async seal", () => {
  it("publishes cleanly when the seal is immediate (no race)", async () => {
    const result = await run(new FakeGitHub(0));
    expect(result).toEqual({ state: "published", tag: TAG, commit: COMMIT, assets: ASSETS.length });
  });

  it("tolerates the mid-seal transient — a real publication is not failed by the async seal", async () => {
    // The uploaded release IS complete and immutable; only the read immediately after publish is transient.
    const result = await run(new FakeGitHub(2));
    expect(result).toEqual({ state: "published", tag: TAG, commit: COMMIT, assets: ASSETS.length });
  });

  it("fails closed when the release never seals (not a benign race)", async () => {
    await expect(run(new FakeGitHub(Number.POSITIVE_INFINITY))).rejects.toThrow();
  });
});
