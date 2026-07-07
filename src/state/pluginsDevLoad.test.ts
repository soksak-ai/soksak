// devLoad 재적재 — 이전에 enabled 였던 dev 플러그인은 reload 후에도 enabled 로 되살아난다(명령 재등록).
// 개발 반복(load→enable→load→enable...)의 게이트 제거: dev 소스는 동의 면제(§0-5)이므로 신선 코드는
// 같은 동의 지위로 자동 재활성화. 처음 보는(enabledIds 밖) id 는 여전히 disabled(현행 유지).
import { beforeEach, describe, expect, it, vi } from "vitest";

// blob ESM 은 jsdom 미실행(loader.ts 주석) — 로더를 주입해 활성화 경로를 계약 테스트한다.
const activatedIds: string[] = [];
const activeIds = new Set<string>();
vi.mock("../plugins/loader", () => ({
  importPluginModule: vi.fn(async () => ({ activate: () => {} })),
  activatePlugin: vi.fn(async (_mod: unknown, manifest: { id: string }) => {
    // activatePlugin 이 명령을 등록한다 — 이 호출이 "명령 재등록"의 런타임 지점.
    activatedIds.push(manifest.id);
    return { id: manifest.id, disposables: [], dispose: () => {} };
  }),
  isActive: (id: string) => activeIds.has(id),
  setActive: (id: string) => {
    activeIds.add(id);
  },
  deactivateById: vi.fn(async (id: string) => {
    activeIds.delete(id);
    return true;
  }),
  deactivateAll: vi.fn(async () => {
    activeIds.clear();
  }),
}));

const invoke = vi.fn(async (cmd: string, args?: { path?: string }) => {
  if (cmd === "read_text_file") {
    const path = args?.path ?? "";
    if (path.endsWith("/plugin.json")) {
      return {
        content: JSON.stringify({
          spec: "soksak-plugin-spec@1",
          id: "soksak-plugin-demo",
          name: "데모",
          version: "1.0.0",
          description: "테스트용 dev 플러그인",
          permissions: [],
        }),
      };
    }
    // entry(main.js)
    return { content: "export const activate = () => {};" };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, { path?: string }])),
}));

import { usePlugins, type PluginRuntime } from "./plugins";
import { parseManifest } from "../plugins/spec";

const PATH = "/tmp/soksak-plugin-demo";
const ID = "soksak-plugin-demo";

function demoRuntime(status: PluginRuntime["status"]): PluginRuntime {
  const { manifest } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id: ID,
      name: "데모",
      version: "1.0.0",
      description: "테스트용 dev 플러그인",
      permissions: [],
    },
    ID,
  );
  if (!manifest) throw new Error("테스트 매니페스트 불량");
  return { manifest, dir: PATH, source: "dev", status };
}

beforeEach(() => {
  activatedIds.length = 0;
  activeIds.clear();
  invoke.mockClear();
  usePlugins.setState({
    release: false,
    plugins: {},
    rejected: [],
    consents: {},
    enabledIds: [],
  });
});

describe("devLoad — enabled dev 플러그인 재적재", () => {
  it("이전에 enabled 였다면 dev.load 후에도 enabled + 명령 재등록", async () => {
    // 사전: 이미 enabled·활성 상태(enabledIds 에 등록됨).
    usePlugins.setState({
      plugins: { [ID]: demoRuntime("enabled") },
      enabledIds: [ID],
    });
    activeIds.add(ID); // 활성 인스턴스 존재

    const r = await usePlugins.getState().devLoad(PATH);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    expect(after.status).toBe("enabled");
    // 신선 코드가 재활성화 = 명령 재등록 경로(activatePlugin) 실행됨.
    expect(activatedIds).toContain(ID);
    expect(activeIds.has(ID)).toBe(true);
  });

  it("처음 보는(enabledIds 밖) id 는 dev.load 후 disabled 유지(현행)", async () => {
    // 사전 상태 없음 — 최초 dev.load.
    const r = await usePlugins.getState().devLoad(PATH);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    expect(after.status).toBe("disabled");
    expect(activatedIds).not.toContain(ID);
  });
});
