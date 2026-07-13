// 스캔 견고성 — 플러그인 폴더 아래엔 플러그인 아닌 것도 산다(코어 CLI 도구 soksak-plugin-doctor:
// plugin.json·.soksak.json 둘 다 없음). 스캐너가 그런 폴더를 "깨진 플러그인"으로 오분류해 에러
// 카드를 내면 안 된다. 구분 기준: .soksak.json(설치/dev 상태)이 있는데 plugin.json 만 없으면 진짜
// 깨진 설치본(거부), 둘 다 없으면 애초에 플러그인이 아님(조용히 건너뜀).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/loader", () => ({
  importPluginModule: vi.fn(async () => ({ activate: () => {} })),
  activatePlugin: vi.fn(async () => ({ disposables: [], dispose: () => {} })),
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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
}));

import { usePlugins } from "./plugins";

function goodManifest(id: string): string {
  return JSON.stringify({
    spec: "soksak-spec-plugin@1",
    id,
    name: "정상",
    version: "1.0.0",
    description: "정상 플러그인",
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

describe("plugin_scan 견고성 — 비-플러그인 폴더는 에러가 아니다", () => {
  it("plugin.json·.soksak.json 둘 다 없는 폴더(코어 도구 doctor)는 조용히 건너뛴다", async () => {
    scan = [
      {
        dir: "/home/plugins/soksak-plugin-doctor",
        dir_name: "soksak-plugin-doctor",
        manifest: null,
        state: null,
        error: "plugin.json 읽기 실패: No such file or directory (os error 2)",
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

  it(".soksak.json(설치 상태)은 있는데 plugin.json 이 없으면 진짜 깨진 설치본이라 거부한다", async () => {
    scan = [
      {
        dir: "/home/plugins/soksak-plugin-broken",
        dir_name: "soksak-plugin-broken",
        manifest: null,
        state: installedState, // 설치는 됐는데 매니페스트가 사라졌다 — 침묵 금지.
        error: "plugin.json 읽기 실패: No such file or directory (os error 2)",
      },
    ];

    await usePlugins.getState().reload();

    expect(
      usePlugins.getState().rejected.some((r) => r.dir.endsWith("soksak-plugin-broken")),
    ).toBe(true);
  });
});
