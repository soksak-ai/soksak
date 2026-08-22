import { describe, expect, it, vi } from "vitest";
import { installRegistryRelease } from "./registryInstallTransaction";

const digest = (value: string) => value.repeat(64);
const release = {
  plugin: { id: "demo", version: "0.0.1" },
  source: { repository: "https://github.com/example/demo", commit: "a".repeat(40) },
  artifacts: [{ target: "any", url: "https://github.com/example/demo/releases/download/v0.0.1/demo.tgz", size: 3, sha256: digest("b"), format: "tgz", manifest: "plugin.json" }],
  reports: [{ url: "https://github.com/example/demo/releases/download/v0.0.1/report.json", sha256: digest("c") }],
} as const;
const certified = { index: { id: "official", plugins: [release], sidecars: [], kits: [], contracts: [], specs: [] } } as never;

describe("direct registry installation", () => {
  it("stages and commits one exact release", async () => {
    const commit = vi.fn(async () => ({ revision: 2 }));
    const result = await installRegistryRelease({
      certified, root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "aarch64-apple-darwin",
      documents: { load: vi.fn() },
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async () => ({ handle: "h", sha256: digest("b"), size: 3, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] }),
        readUtf8: async () => JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: [] }),
        commit, rollback: vi.fn(),
      },
    });
    expect(result).toMatchObject({ ok: true, registryId: "official", revision: 2 });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects staged byte evidence and rolls back", async () => {
    const rollback = vi.fn(async () => {});
    const result = await installRegistryRelease({
      certified, root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "any",
      documents: { load: vi.fn() },
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async () => ({ handle: "h", sha256: digest("e"), size: 3, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] }),
        readUtf8: vi.fn(), commit: vi.fn(), rollback,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "UNSAFE_EXTRACTION" });
    expect(rollback).toHaveBeenCalledWith("tx");
  });
});
