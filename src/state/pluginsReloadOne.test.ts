// id 지정 재적재 — 그 플러그인의 매니페스트를 디스크에서 다시 읽는다.
// 다시 읽지 않으면 신선 코드가 옛 매니페스트로 켜진다: 새 명령을 등록하는 코드가 "선언되지 않은
// 명령" 으로 거부되고, 에러는 파일이 아니라 캐시를 가리켜 저자를 엉뚱한 곳으로 보낸다(실측).
import { beforeEach, describe, expect, it, vi } from "vitest";

const activatedIds: string[] = [];
const activeIds = new Set<string>();
vi.mock("../plugins/loader", () => ({
  importPluginModule: vi.fn(async () => ({ activate: () => {} })),
  activatePlugin: vi.fn(async (_mod: unknown, manifest: { id: string }) => {
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

const ID = "soksak-plugin-demo";
const PATH = "/tmp/soksak-plugin-demo";

// 디스크의 현재 매니페스트 — 테스트가 중간에 바꾼다(저자가 파일을 고치는 행위).
let onDisk: Record<string, unknown> = {};

const invoke = vi.fn(async (cmd: string, args?: { path?: string }) => {
  if (cmd === "read_text_file") {
    const path = args?.path ?? "";
    if (path.endsWith("/plugin.json")) return { content: JSON.stringify(onDisk) };
    return { content: "export const activate = () => {};" };
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, { path?: string }])),
}));

import { usePlugins, type PluginRuntime } from "./plugins";
import { parseManifest } from "../plugins/spec";

function manifestJson(commands: string[]): Record<string, unknown> {
  return {
    spec: "soksak-plugin-spec@1",
    id: ID,
    name: "데모",
    version: "1.0.0",
    description: "테스트용 플러그인",
    permissions: ["commands"],
    entry: "main.js",
    contributes: {
      commands: commands.map((name) => ({
        name,
        title: { ko: `${name} 실행`, en: `run ${name}` },
      })),
    },
  };
}

function runtimeOf(json: Record<string, unknown>, status: PluginRuntime["status"]): PluginRuntime {
  const { manifest, validation } = parseManifest(json, ID);
  if (!manifest) throw new Error(`테스트 매니페스트 불량: ${validation.errors.join(", ")}`);
  return { manifest, dir: PATH, source: "dev", status };
}

beforeEach(() => {
  activatedIds.length = 0;
  activeIds.clear();
  invoke.mockClear();
  onDisk = manifestJson(["thing.run"]);
  usePlugins.setState({
    release: false,
    plugins: { [ID]: runtimeOf(manifestJson(["thing.run"]), "enabled") },
    rejected: [],
    consents: {},
    enabledIds: [ID],
  });
  activeIds.add(ID);
});

describe("reloadOne — id 지정 재적재는 디스크의 매니페스트를 다시 읽는다", () => {
  it("파일에 명령이 추가되면 재적재 후 그 명령이 선언 안에 있다", async () => {
    onDisk = manifestJson(["thing.run", "thing.head"]); // 저자가 파일을 고쳤다

    const r = await usePlugins.getState().reloadOne(ID);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    const declared = (after.manifest.contributes?.commands ?? []).map((c) => c.name);
    expect(declared).toContain("thing.head");
    expect(after.status).toBe("enabled");
    expect(activatedIds).toContain(ID); // 신선 코드가 실제로 다시 활성화됐다
  });

  it("파일이 불량이면 조용히 옛 매니페스트로 켜지 않고 거부 이유를 답한다", async () => {
    onDisk = { spec: "soksak-plugin-spec@1", id: ID }; // 필수 필드 결손

    const r = await usePlugins.getState().reloadOne(ID);
    expect(r.ok).toBe(false);
    expect(String((r as { message: string }).message)).not.toHaveLength(0);
    expect(usePlugins.getState().rejected.some((x) => x.dir === PATH)).toBe(true);
  });

  it("없는 id 는 TARGET_NOT_FOUND", async () => {
    const r = await usePlugins.getState().reloadOne("soksak-plugin-nope");
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});
