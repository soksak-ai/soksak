// plugin.conformance 계약 테스트 — declared≡actual 런타임 진단이 결합 법칙 C2 규칙 전부를
// 판정하는지 확인한다. 특히 view-status(런타임 규칙)는 마운트된 콘텐츠 뷰에서만 판정 가능하므로
// 활성화 경계가 아니라 이 런타임 표면이 시행 지점이다(viewStatusConformance 의 유일한 배선).
// 판정은 선언≡보고: 선언(contributes.views[].status) 있고 미보고=위반, 선언 밖 보고=선언 누락 경고.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]) => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { registerPluginCatalog } from "./catalogPlugins";
import { execute, getSpec } from "./registry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useSessions, type ProjectTab, type View } from "../state/sessions";
import { parseManifest, type PluginManifest } from "../plugins/spec";

function manifestOf(id: string, overrides: Record<string, unknown> = {}): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id,
      name: "데모",
      version: "1.0.0",
      description: "테스트",
      permissions: ["ui", "commands"],
      ...overrides,
    },
    id,
  );
  if (!manifest) throw new Error(`테스트 매니페스트 불량: ${validation.errors}`);
  return manifest;
}

function runtimeOf(manifest: PluginManifest): PluginRuntime {
  return { manifest, dir: "/d", source: "dev", status: "enabled" };
}

// 콘텐츠 영역 하나에 플러그인 뷰 인스턴스들을 실은 최소 탭(핸들러가 읽는 경로만 채운다).
function tabWith(views: View[]): ProjectTab {
  return {
    id: "t1",
    contents: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", views, activeViewId: views[0]?.id ?? "" } },
        activeGroupId: "g1",
      },
    ],
    activeContentId: "c1",
  } as unknown as ProjectTab;
}

const pluginView = (over: Partial<View> & { id: string; pluginId: string; view: string }): View =>
  ({ kind: "plugin", title: "Canvas", ...over }) as View;

beforeAll(() => {
  if (!getSpec("plugin.conformance")) registerPluginCatalog();
});

beforeEach(() => {
  invoke.mockClear();
  usePlugins.setState({ plugins: {} });
  useSessions.setState({ tabs: [] });
});

afterEach(() => {
  usePlugins.setState({ plugins: {} });
  useSessions.setState({ tabs: [] });
});

describe("plugin.conformance 등록(발견성)", () => {
  it("returns 계약이 c2 필드를 고지한다", () => {
    const spec = getSpec("plugin.conformance");
    expect(spec).toBeDefined();
    expect(spec!.returns).toContain("c2");
  });
});

// 응답 c2.viewStatus 의 계약 형태(선언≡보고 판정: unreported=선언 있고 미보고, undeclared=선언 밖 보고).
interface C2Result {
  violations: { rule: string; detail: string }[];
  viewStatus: {
    mounted: string[];
    reported: string[];
    unreported: string[];
    undeclared: { viewId: string; view: string; code: string }[];
  };
}

describe("plugin.conformance — C2 view-status(런타임 판정, viewStatusConformance 배선 — 선언≡보고)", () => {
  const declaredManifest = (id: string, status?: string[]) =>
    manifestOf(id, {
      contributes: {
        views: [
          {
            id: "canvas",
            title: "캔버스",
            icon: "C",
            placements: ["content"],
            ...(status !== undefined ? { status } : {}),
          },
        ],
        commands: [{ name: "open", title: "열기" }],
        nodes: [{ id: "root" }],
      },
    });

  it("status 선언 뷰의 순간 미보고는 정보일 뿐 위반이 아니다(null=보고할 것 없음)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["idle", "busy"])) } });
    // 콘텐츠 뷰 두 인스턴스: v1 은 status 미보고(선언 있음 → 위반), v2 는 선언된 코드 보고.
    useSessions.setState({
      tabs: [
        tabWith([
          pluginView({ id: "v1", pluginId: id, view: "canvas" }),
          pluginView({ id: "v2", pluginId: id, view: "canvas", status: { code: "idle" } }),
        ]),
      ],
    });

    const r = await execute("plugin.conformance", { id }, {});
    expect(r.ok).toBe(true);
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2).toBeDefined();
    expect(c2.viewStatus.mounted).toEqual(["v1", "v2"]);
    expect(c2.viewStatus.reported).toEqual(["v2"]);
    expect(c2.viewStatus.unreported).toEqual(["v1"]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
  });

  it("모든 콘텐츠 뷰가 선언된 코드를 보고하면 view-status 위반 없음", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["running"])) } });
    useSessions.setState({
      tabs: [tabWith([pluginView({ id: "v1", pluginId: id, view: "canvas", status: { code: "running" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.unreported).toEqual([]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
    expect(c2.violations.map((v) => v.rule)).not.toContain("content-view-status");
  });

  it("무상태 선언([]) 뷰의 침묵은 위반이 아니다(선언≡보고)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, [])) } });
    useSessions.setState({
      tabs: [tabWith([pluginView({ id: "v1", pluginId: id, view: "canvas" })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.unreported).toEqual([]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
    expect(c2.violations.map((v) => v.rule)).not.toContain("content-view-status");
  });

  it("선언 없이 보고 → undeclared = view-status 위반(선언 밖 코드)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, undefined)) } });
    useSessions.setState({
      tabs: [tabWith([pluginView({ id: "v1", pluginId: id, view: "canvas", status: { code: "idle" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.undeclared).toEqual([{ viewId: "v1", view: "canvas", code: "idle" }]);
    const vs = c2.violations.filter((v) => v.rule === "view-status");
    expect(vs.some((v) => v.detail.includes("idle"))).toBe(true);
  });

  it("선언 목록 밖 코드 보고 → undeclared = view-status 위반", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["ready"])) } });
    useSessions.setState({
      tabs: [tabWith([pluginView({ id: "v1", pluginId: id, view: "canvas", status: { code: "wat" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.undeclared).toEqual([{ viewId: "v1", view: "canvas", code: "wat" }]);
    const vs = c2.violations.filter((v) => v.rule === "view-status");
    expect(vs.some((v) => v.detail.includes("wat"))).toBe(true);
  });
});

describe("plugin.conformance — C2 정적 규칙(command-surface·view-nodes)", () => {
  it("파일 뷰어만 기여하고 command=0 → c2.violations 에 command-surface", async () => {
    const id = "viewer";
    const manifest = manifestOf(id, {
      permissions: ["ui"],
      contributes: {
        fileViewers: [{ id: "image", extensions: ["png"] }],
      },
    });
    usePlugins.setState({ plugins: { [id]: runtimeOf(manifest) } });

    const r = await execute("plugin.conformance", { id }, {});
    const data = (r as { data: Record<string, unknown> }).data;
    const c2 = data.c2 as { violations: { rule: string }[] };
    expect(c2.violations.map((v) => v.rule)).toContain("command-surface");
  });
});
