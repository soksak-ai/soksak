// Scan robustness — the plugin folder also holds non-plugins (the core CLI tool soksak-plugin-doctor
// has neither plugin.json nor .soksak.json). The scanner must not misclassify such a folder as a
// "broken plugin" and raise an error card. Rule: .soksak.json (install/dev state) present and only
// plugin.json missing = a genuinely broken install (reject); neither present = not a plugin at all
// (skip silently).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/loader", () => ({
  activateContractPlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  importPluginModule: vi.fn(async () => ({})),
  activatePlugin: vi.fn(async (_m: unknown, manifest: { id: string }, dir: string) => ({ manifest, dir, deactivate: async () => {} })),
  isActive: () => false,
  setActive: () => {},
  deactivateById: vi.fn(async () => true),
  deactivateAll: vi.fn(async () => {}),
}));

interface ScanEntry {
  dir: string;
  dir_name: string;
  manifest: string | null;
  state: string | null;
  error: string | null;
}
let scan: ScanEntry[] = [];

const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "plugin_scan") return scan;
  return undefined;
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
}));

import { usePlugins } from "./plugins";

function goodManifest(id: string): string {
  return JSON.stringify({
    spec: "0.0.1",
    id,
    name: "good",
    version: "1.0.0",
    description: "a good plugin",
    permissions: ["commands"],
    entry: "main.js",
    contributes: { commands: [{ name: "x.run", title: { ko: "실행", en: "run" } }] },
  });
}

const installedState = '{"version":"1.0.0","repo":"https://x/y.git","branch":"main"}';
beforeEach(() => {
  invoke.mockClear();
  usePlugins.setState({ release: false, plugins: {}, rejected: [], consents: {}, enabledIds: [] });
});

describe("plugin_scan robustness — a non-plugin folder is not an error", () => {
  it("a folder with neither plugin.json nor .soksak.json (the core tool doctor) is skipped silently", async () => {
    scan = [
      {
        dir: "/home/plugins/soksak-plugin-doctor",
        dir_name: "soksak-plugin-doctor",
        manifest: null,
        state: null,
        error: "reading plugin.json failed: No such file or directory (os error 2)",
      },
      {
        dir: "/home/plugins/soksak-plugin-good",
        dir_name: "soksak-plugin-good",
        manifest: goodManifest("soksak-plugin-good"),
        state: installedState,
        error: null,
      },
    ];

    await usePlugins.getState().reload();

    const rej = usePlugins.getState().rejected;
    expect(rej.some((r) => r.dir.endsWith("soksak-plugin-doctor"))).toBe(false);
    expect(usePlugins.getState().plugins["soksak-plugin-good"]).toBeDefined();
  });

  it("a folder with .soksak.json (install state) but no plugin.json is a genuinely broken install and is refused", async () => {
    scan = [
      {
        dir: "/home/plugins/soksak-plugin-broken",
        dir_name: "soksak-plugin-broken",
        manifest: null,
        state: installedState, // installed, but the manifest is gone — no silence.
        error: "reading plugin.json failed: No such file or directory (os error 2)",
      },
    ];

    await usePlugins.getState().reload();

    expect(
      usePlugins.getState().rejected.some((r) => r.dir.endsWith("soksak-plugin-broken")),
    ).toBe(true);
  });

});
