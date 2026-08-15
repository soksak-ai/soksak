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
const INSTALLED = "/home/plugins/weather";
const DEVELOPMENT = "/work/weather";
let devReadable = true;

function manifest(version: string): string {
  return JSON.stringify({
    spec: "soksak-spec-plugin@0.0.1",
    id: ID,
    name: "Weather",
    version,
    description: "weather plugin",
    permissions: [],
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
    const args = input[1] as { path?: string } | undefined;
    if (cmd === "plugin_scan") {
      return [
        {
          dir: INSTALLED,
          dir_name: ID,
          manifest: manifest("1.0.0"),
          state: '{"version":"1.0.0"}',
          error: null,
        },
      ];
    }
    if (cmd === "unit_source_list") return [{ kind: "plugin", id: ID, source: DEVELOPMENT }];
    if (cmd === "read_text_file" && args?.path === `${DEVELOPMENT}/plugin.json`) {
      if (!devReadable) throw new Error("missing workspace");
      return { content: manifest("2.0.0") };
    }
    return undefined;
  });
  usePlugins.setState({
    release: true,
    appVersion: "1.0.0",
    plugins: {},
    rejected: [],
    consents: {},
    enabledIds: [],
  });
});

describe("development unit source selection", () => {
  it("a declared source overrides a separate official install, release core included", async () => {
    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toMatchObject({
      dir: DEVELOPMENT,
      source: "dev",
      manifest: { version: "2.0.0" },
    });
  });

  it("a broken selected source does not fall back to the official install", async () => {
    devReadable = false;

    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toBeUndefined();
    expect(usePlugins.getState().rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dir: DEVELOPMENT, errors: [expect.stringContaining("missing workspace")] }),
      ]),
    );
  });
});
