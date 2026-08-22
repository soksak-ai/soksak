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
const settings = { revision: 1, plugins: { demo: { enabled: false } }, sidecars: {}, kits: {}, contracts: {}, specs: {} } as const;
const installed = { revision: 1, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} } as const;

describe("direct registry installation", () => {
  it("stages and commits one exact release", async () => {
    const commit = vi.fn(async (_values: unknown) => ({ revision: 2 }));
    const result = await installRegistryRelease({
      certified, root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "aarch64-apple-darwin",
      settings, installed,
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async () => ({ handle: "h", sha256: digest("b"), size: 3, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] }),
        readUtf8: async () => JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: [] }),
        commit: async (_, __, values) => commit(values), rollback: vi.fn(),
      },
    });
    expect(result).toMatchObject({ ok: true, registryId: "official", revision: 2 });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects staged byte evidence and rolls back", async () => {
    const rollback = vi.fn(async () => {});
    const result = await installRegistryRelease({
      certified, root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "any",
      settings, installed,
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async () => ({ handle: "h", sha256: digest("e"), size: 3, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] }),
        readUtf8: vi.fn(), commit: vi.fn(), rollback,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "UNSAFE_EXTRACTION" });
    expect(rollback).toHaveBeenCalledWith("tx");
  });

  it("installs selected sidecar providers in the same transaction", async () => {
    const sidecarRelease = {
      sidecar: { id: "state", version: "0.0.7" },
      source: { repository: "https://github.com/example/state", commit: "d".repeat(40) },
      artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/example/state/releases/download/v0.0.7/state.tgz", size: 4, sha256: digest("e"), format: "tar.gz", manifest: "sidecar.json" }],
      reports: [{ url: "https://github.com/example/state/releases/download/v0.0.7/report.json", sha256: digest("f") }],
    } as const;
    const index = { index: { id: "official", plugins: [release], sidecars: [sidecarRelease], kits: [], contracts: [], specs: [] } } as never;
    const staged: string[] = [];
    const committed: unknown[][] = [];
    const result = await installRegistryRelease({
      certified: index,
      root: { kind: "plugin", id: "demo", version: "0.0.1" },
      target: "aarch64-apple-darwin",
      settings: { revision: 1, plugins: { demo: { enabled: false, providers: { state: "state" } } }, sidecars: {}, kits: {}, contracts: {}, specs: {} },
      installed: { revision: 3, plugins: {}, sidecars: {}, kits: {}, contracts: {}, specs: {} },
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async ({ release }) => {
          staged.push(`${release.kind}:${release.id}`);
          return { handle: release.id, sha256: release.kind === "plugin" ? digest("b") : digest("e"), size: release.kind === "plugin" ? 3 : 4, manifestSha256: digest("d"), extraction: "regular-files-only" as const, verifiedEntrypoints: [release.kind + ".json"] };
        },
        readUtf8: async (_, handle) => handle === "demo"
          ? JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: ["sidecar"], sidecars: [{ name: "state", interface: { id: "soksak-spec-sidecar-terminal", requirement: "0.0.1" } }] })
          : JSON.stringify({ id: "state", version: "0.0.7", interface: { id: "soksak-spec-sidecar-terminal", version: "0.0.1" }, process: "dist/state" }),
        commit: async (_, expectedRevision, values) => {
          expect(expectedRevision).toBe(3);
          committed.push([...values]);
          return { revision: 4 };
        },
        rollback: async () => {},
      },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, revision: 4 });
    expect(staged).toEqual(["plugin:demo", "sidecar:state"]);
    expect(committed[0]).toHaveLength(2);
  });

  it("reuses an exact installed sidecar provider", async () => {
    const sidecarRelease = {
      sidecar: { id: "state", version: "0.0.7" },
      source: { repository: "https://github.com/example/state", commit: "d".repeat(40) },
      artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/example/state/releases/download/v0.0.7/state.tgz", size: 4, sha256: digest("e"), format: "tar.gz", manifest: "sidecar.json" }],
      reports: [{ url: "https://github.com/example/state/releases/download/v0.0.7/report.json", sha256: digest("f") }],
    } as const;
    const index = { index: { id: "official", plugins: [release], sidecars: [sidecarRelease], kits: [], contracts: [], specs: [] } } as never;
    const staged: string[] = [];
    const result = await installRegistryRelease({
      certified: index, root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "aarch64-apple-darwin",
      settings: { revision: 1, plugins: { demo: { enabled: false, providers: { state: "state" } } }, sidecars: {}, kits: {}, contracts: {}, specs: {} },
      installed: { revision: 3, plugins: {}, sidecars: { state: { version: "0.0.7", path: "/state", registryId: "official", repository: "https://github.com/example/state", sourceCommit: "d".repeat(40), manifestSha256: digest("a"), artifactSha256: digest("e"), target: "aarch64-apple-darwin" } }, kits: {}, contracts: {}, specs: {} },
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async ({ release }) => { staged.push(release.kind + ":" + release.id); return { handle: release.id, sha256: digest("b"), size: 3, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] }; },
        readUtf8: async () => JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: ["sidecar"], sidecars: [{ name: "state", interface: { id: "soksak-spec-sidecar-terminal", requirement: "0.0.1" } }] }),
        commit: async (_, __, values) => ({ revision: values.length + 3 }), rollback: async () => {},
      },
    });
    expect(result).toMatchObject({ ok: true, revision: 4 });
    expect(staged).toEqual(["plugin:demo"]);
  });

  it("rolls back when the selected sidecar interface is incompatible", async () => {
    const rollback = vi.fn(async () => {});
    const sidecarRelease = {
      sidecar: { id: "state", version: "0.0.7" },
      source: { repository: "https://github.com/example/state", commit: "d".repeat(40) },
      artifacts: [{ target: "aarch64-apple-darwin", url: "https://github.com/example/state/releases/download/v0.0.7/state.tgz", size: 4, sha256: digest("e"), format: "tar.gz", manifest: "sidecar.json" }],
      reports: [{ url: "https://github.com/example/state/releases/download/v0.0.7/report.json", sha256: digest("f") }],
    } as const;
    const result = await installRegistryRelease({
      certified: { index: { id: "official", plugins: [release], sidecars: [sidecarRelease], kits: [], contracts: [], specs: [] } } as never,
      root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "aarch64-apple-darwin",
      settings: { revision: 1, plugins: { demo: { enabled: false, providers: { state: "state" } } }, sidecars: {}, kits: {}, contracts: {}, specs: {} },
      installed,
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async ({ release }) => ({ handle: release.id, sha256: release.kind === "plugin" ? digest("b") : digest("e"), size: release.kind === "plugin" ? 3 : 4, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: [release.kind + ".json"] }),
        readUtf8: async (_, handle) => handle === "demo"
          ? JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: ["sidecar"], sidecars: [{ name: "state", interface: { id: "soksak-spec-sidecar-terminal", requirement: "0.0.1" } }] })
          : JSON.stringify({ id: "state", version: "0.0.7", interface: { id: "soksak-spec-sidecar-other", version: "0.0.1" }, process: "dist/state" }),
        commit: vi.fn(), rollback,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "RELEASE_VERIFICATION_FAILED" });
    expect(rollback).toHaveBeenCalledWith("tx");
  });

  it("installs plugin dependencies transitively without staging duplicates", async () => {
    const dependencyRelease = {
      plugin: { id: "base", version: "0.0.1" },
      source: { repository: "https://github.com/example/base", commit: "1".repeat(40) },
      artifacts: [{ target: "any", url: "https://github.com/example/base/releases/download/v0.0.1/base.tgz", size: 5, sha256: digest("1"), format: "tgz", manifest: "plugin.json" }],
      reports: [{ url: "https://github.com/example/base/releases/download/v0.0.1/report.json", sha256: digest("2") }],
    } as const;
    const staged: string[] = [];
    const result = await installRegistryRelease({
      certified: { index: { id: "official", plugins: [release, dependencyRelease], sidecars: [], kits: [], contracts: [], specs: [] } } as never,
      root: { kind: "plugin", id: "demo", version: "0.0.1" }, target: "any", settings, installed,
      artifacts: {
        begin: async () => ({ transactionId: "tx" }),
        stage: async ({ release }) => {
          staged.push(release.id);
          return { handle: release.id, sha256: release.id === "demo" ? digest("b") : digest("1"), size: release.id === "demo" ? 3 : 5, manifestSha256: digest("d"), extraction: "regular-files-only", verifiedEntrypoints: ["plugin.json"] };
        },
        readUtf8: async (_, handle) => handle === "demo"
          ? JSON.stringify({ id: "demo", name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Demo", permissions: [], dependencies: { base: "0.0.1" } })
          : JSON.stringify({ id: "base", name: "Base", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Base", permissions: [] }),
        commit: async (_, __, values) => ({ revision: values.length + 1 }), rollback: async () => {},
      },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, revision: 3 });
    expect(staged).toEqual(["demo", "base"]);
  });

});
