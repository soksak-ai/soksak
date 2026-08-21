// Verifies the development source config stays separate from the installed copy and applies the
// same way in a release core. Not falling back silently to the official install when the selected
// source is broken is part of the same contract.
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

const ID = "weather";
const DEVELOPMENT = "/work/weather";
let devReadable = true;

function manifest(version: string): string {
  return JSON.stringify({
    spec: "soksak-spec-plugin@0.0.1",
    id: ID,
    name: "Weather",
    version,
    description: "weather plugin",
    permissions: ["commands", "sidecar", "service"],
    entry: null,
    sidecars: [{ name: "weather-service", interface: { id: "weather-wire", version: "0.0.1" } }],
    service: {
      sidecar: "weather-service",
      interface: { id: "weather", version: "0.0.1" },
      subscribe: [],
    },
    contributes: {
      commands: [{
        name: "run", title: { ko: "실행", en: "Run" }, bind: "service",
        description: "Runs the weather service.", params: {},
      }],
    },
  });
}

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: (...a: unknown[]) => invoke(...a) }));

import { usePlugins } from "./plugins";

beforeEach(() => {
  devReadable = true;
  invoke.mockReset();
  invoke.mockImplementation(async (...input: unknown[]): Promise<unknown> => {
    const cmd = input[0] as string;
    if (cmd === "plugin_manifest_list") {
      return [
        {
          id: ID, version: "0.0.1", installPath: DEVELOPMENT, manifestPath: "plugin.json",
          development: true, enabled: true,
          manifest: devReadable ? manifest("0.0.1") : null,
          error: devReadable ? null : "missing workspace",
        },
      ];
    }
    return undefined;
  });
  usePlugins.setState({
    release: true,
    appVersion: "1.0.0",
    plugins: {},
    rejected: [],
    consents: {},
    enabledIds: ["stale-local-only-id"],
  });
});

describe("development unit source selection", () => {
  it("loads the exact development record declared by composition settings", async () => {
    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toMatchObject({
      dir: DEVELOPMENT,
      source: "dev",
      status: "enabled",
      manifest: { version: "0.0.1" },
    });
    expect(usePlugins.getState().enabledIds).toEqual([ID]);
    expect(invoke).not.toHaveBeenCalledWith("plugin_scan");
    expect(invoke).not.toHaveBeenCalledWith("unit_source_list");
  });

  it("reports a broken declared record without scanning for a substitute", async () => {
    devReadable = false;

    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toBeUndefined();
    expect(usePlugins.getState().rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ID, dir: DEVELOPMENT, errors: [expect.stringContaining("missing workspace")] }),
      ]),
    );
  });

  it("rejects a plugin manifest whose version differs from settings", async () => {
    invoke.mockImplementation(async (...input: unknown[]): Promise<unknown> => {
      const command = input[0] as string;
      if (command === "plugin_manifest_list") {
        return [{
          id: ID, version: "0.0.1", installPath: DEVELOPMENT, manifestPath: "plugin.json",
          development: true, enabled: false, manifest: manifest("0.0.2"), error: null,
        }];
      }
      return undefined;
    });

    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toBeUndefined();
    expect(usePlugins.getState().rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ID, errors: [expect.stringContaining("0.0.1")] }),
    ]));
  });
});
