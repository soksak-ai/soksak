// Development source config가 설치본과 분리되어 있고 release core에서도 동일하게 적용되는지 검증한다.
// 선택한 source가 깨졌을 때 공식 설치본으로 조용히 fallback하지 않는 것도 계약이다.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/loader", () => ({
  activateContractPlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  isActive: () => false,
  setActive: () => {},
  deactivateById: vi.fn(async () => true),
  deactivateAll: vi.fn(async () => {}),
}));
vi.mock("../plugins/nativeRuntime", () => ({
  startNativePluginRuntime: vi.fn(async () => ({ deactivate: async () => {} })),
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

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
    if (cmd === "unit_dev_list") return [{ kind: "plugin", id: ID, source: DEVELOPMENT }];
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
  it("release core에서도 선언된 source가 별도 공식 설치본을 덮는다", async () => {
    await usePlugins.getState().reload();

    expect(usePlugins.getState().plugins[ID]).toMatchObject({
      dir: DEVELOPMENT,
      source: "dev",
      manifest: { version: "2.0.0" },
    });
  });

  it("선택한 source가 깨지면 공식 설치본으로 조용히 fallback하지 않는다", async () => {
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
