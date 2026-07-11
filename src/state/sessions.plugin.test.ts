// sessions 의 plugin View variant 계약 — openPluginView dedupe/활성화/닫기 경로.
// (close/move/drag 는 view id 제네릭이라 기존 동작 그대로 — 여기선 plugin 특화만 고정.)
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, allViews, useSessions } from "./sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { usePlugins, type PluginRuntime } from "./plugins";
import { useContractSelection } from "./contractSelection";
import { parseManifest } from "../plugins/spec";

// 부트 모델(P3): 초기 tabs 는 비어 있고 main.tsx 가 bootstrapFirstProject 로
// 첫 프로젝트를 만든다 — 테스트도 같은 경로로 t1 을 준비한 뒤 스냅샷.
useSessions.getState().bootstrapFirstProject("/tmp/soksak-test-root");

// 시작 상태 스냅샷(데이터만) — 각 테스트 전 복원.
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

function activeLayout() {
  const s = useSessions.getState();
  const t = s.tabs.find((x) => x.id === s.activeId)!;
  const c = t.contents.find((x) => x.id === t.activeContentId)!;
  return { t, c, groups: allGroups(c.layout) };
}

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("openPluginView", () => {
  it("활성 그룹에 plugin 뷰 탭 생성 + 활성화", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "메모");
    expect(r).toMatchObject({ ok: true, existing: false });
    if (!r.ok) return;
    const { c, groups } = activeLayout();
    const grp = groups.find((g) => g.id === r.groupId)!;
    expect(c.activeGroupId).toBe(r.groupId);
    expect(grp.activeViewId).toBe(r.viewId);
    const v = grp.views.find((x) => x.id === r.viewId)!;
    expect(v).toMatchObject({
      kind: "plugin",
      pluginId: "soksak-plugin-memo",
      view: "panel",
      title: "메모",
    });
  });

  it("같은 pluginId+view 재요청은 기존 탭 재사용(existing) + 활성화", () => {
    const first = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "메모");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 다른 뷰를 활성화해 둔 뒤 재요청 → 기존 plugin 뷰로 복귀해야 한다.
    // (빈 그룹 모델 — 첫 화면 자동 뷰가 없으므로 다른 plugin 뷰를 하나 더 열어 활성으로 둔다.)
    const other = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "view", "디프");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.viewId).not.toBe(first.viewId);

    const again = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "메모");
    expect(again).toMatchObject({
      ok: true,
      existing: true,
      viewId: first.viewId,
    });
    const after = activeLayout();
    expect(after.groups.find((g) => g.id === (again as { groupId: string }).groupId)!.activeViewId).toBe(
      first.viewId,
    );
  });

  it("다른 뷰 id 면 별도 탭(dedupe 키 = pluginId+view)", () => {
    const a = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "view", "디프");
    const b = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "history", "이력");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.viewId).not.toBe(b.viewId);
  });

  it("없는 프로젝트는 TARGET_NOT_FOUND", () => {
    const r = useSessions
      .getState()
      .openPluginView("ghost", "soksak-plugin-memo", "panel", "메모");
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});

describe("closeView — plugin 뷰", () => {
  it("plugin 뷰 탭 닫기 후 그룹에서 제거", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "메모");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const closed = useSessions.getState().closeView("t1", r.viewId);
    expect(closed.ok).toBe(true);
    const { groups } = activeLayout();
    expect(
      groups.flatMap((g) => g.views).some((v) => v.id === r.viewId),
    ).toBe(false);
  });
});

// 등록 프로그램 kind=view → +메뉴/addContent 가 plugin 뷰 콘텐츠를 연다(§2.6, plugin-agnostic).
describe("addContent — kind=view 프로그램", () => {
  it("등록된 view 프로그램으로 새 콘텐츠 첫 뷰 = 해당 플러그인 뷰", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-erd", {
      id: "erd-prog-test",
      title: "ERD",
      path: "유틸리티",
      kind: "view",
      view: "canvas",
    });
    try {
      const r = useSessions.getState().addContent("t1", "erd-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { c, groups } = activeLayout();
      expect(c.id).toBe(r.contentId);
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.views.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-erd",
        view: "canvas",
        title: "ERD",
      });
    } finally {
      dispose();
    }
  });

  // 에이전트 프로그램(agent-claude)이 다른 플러그인(terminal)의 뷰를 자동실행 명령과 함께 연다.
  // viewPlugin = 뷰 소유 플러그인(크로스 플러그인 참조), command = 그 터미널 뷰에 흘려보낼 자동실행 명령.
  it("크로스 플러그인 view 프로그램 + command → 대상 플러그인 뷰 + autorun 명령 전달", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-agent-claude", {
      id: "claude-prog-test",
      title: "Claude",
      path: "에이전트",
      kind: "view",
      view: "content",
      viewPlugin: "soksak-plugin-terminal",
      command: "claude",
      ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
    });
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { groups } = activeLayout();
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.views.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal", // viewPlugin — 뷰 소유 플러그인(자기 plugin 아님)
        view: "content",
        title: "Claude",
        command: "claude", // 자동실행 명령이 plugin View 에 실린다
      });
    } finally {
      dispose();
    }
  });

  // viewPlugin 미지정이면 자기 플러그인 뷰(터미널 플러그인의 terminal 프로그램 — 후방호환).
  it("viewPlugin 미지정 = 자기 플러그인 뷰(후방호환)", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-terminal", {
      id: "terminal-prog-test",
      title: "Terminal",
      kind: "view",
      view: "content",
    });
    try {
      const r = useSessions.getState().addViewToGroup("t1", "terminal-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { groups } = activeLayout();
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.views.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal",
        view: "content",
      });
      expect((v as { command?: string }).command).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

// project.create 의 초기 program — addProject 가 program 을 받아 첫 그룹에 뷰를 만든다.
// (터미널 플러그인화 이후 커맨드가 program 을 선언만 하고 버려 빈 패널(검은 화면)로
// 보이던 결함의 재현·고정 — 생략 시 빈 스켈레톤은 기존 설계 그대로.)
describe("addProject — 초기 program", () => {
  it("program 지정 시 첫 그룹에 그 프로그램 뷰 + activeViewId + viewId 반환", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-terminal", {
      id: "terminal-prog-test",
      title: "Terminal",
      kind: "view",
      view: "content",
    });
    try {
      const r = useSessions.getState().addProject({
        alias: "px",
        root: "/tmp/soksak-test-addproject",
        program: "terminal-prog-test",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.viewId).toBeTruthy();
      const t = useSessions.getState().tabs.find((x) => x.id === r.projectId)!;
      const grp = allGroups(t.contents[0].layout).find((g) => g.id === r.groupId)!;
      expect(grp.activeViewId).toBe(r.viewId);
      const v = grp.views.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal",
        view: "content",
        title: "Terminal",
      });
    } finally {
      dispose();
    }
  });

  it("program 생략 시 빈 스켈레톤(뷰 0, viewId 미반환) — 기존 설계 유지", () => {
    const r = useSessions.getState().addProject({
      alias: "",
      root: "/tmp/soksak-test-addproject-empty",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.viewId).toBeUndefined();
    const t = useSessions.getState().tabs.find((x) => x.id === r.projectId)!;
    expect(allViews(t.contents[0].layout)).toHaveLength(0);
  });

  it("미등록 program 은 빈 스켈레톤으로 격하(뷰 생성 불가 — makeContent 계약)", () => {
    const r = useSessions.getState().addProject({
      alias: "",
      root: "/tmp/soksak-test-addproject-unreg",
      program: "no-such-program",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.viewId).toBeUndefined();
  });
});

// viewContract(계약-핀 C3) — 프로그램이 플러그인 id 대신 계약을 참조하면 코어는 활성 구현체를
// 발견(implementersOf)하고 사용자 설정으로 하나를 골라 그 구현체의 뷰를 연다. 코어는 계약 의미
// 무지 — 특정 플러그인 id 하드코딩 0(plugin-agnostic). view id 는 프로그램 선언값(관례 content).
describe("addViewToGroup — viewContract(계약-핀) 해소", () => {
  const XTERM = "soksak-plugin-terminal-xterm";
  const GHOSTTY = "soksak-plugin-terminal-ghostty";
  const CONTRACT = "terminal-spec@1";

  // 픽스처 런타임 — 실 스키마 게이트(parseManifest)를 통과시킨다(implements 는 스펙 검증 필드).
  function fixtureRuntime(
    id: string,
    implementsIds: string[],
    status: PluginRuntime["status"] = "enabled",
  ): PluginRuntime {
    const { manifest, validation } = parseManifest(
      {
        spec: "soksak-plugin-spec@1",
        id,
        name: "픽스처",
        version: "1.0.0",
        description: "계약 픽스처",
        permissions: [],
        ...(implementsIds.length > 0 ? { implements: implementsIds } : {}),
      },
      id,
    );
    if (!manifest) throw new Error(`픽스처 매니페스트 불량: ${validation.errors.join("; ")}`);
    return { manifest, dir: `/tmp/${id}`, source: "dev", status };
  }

  beforeEach(() => {
    // 두 엔진이 같은 계약을 활성 상태로 구현(발견 순서 = xterm, ghostty).
    usePlugins.setState({
      plugins: {
        [XTERM]: fixtureRuntime(XTERM, [CONTRACT]),
        [GHOSTTY]: fixtureRuntime(GHOSTTY, [CONTRACT]),
      },
    });
    useContractSelection.setState({ selected: {} });
  });

  // 계약 참조 프로그램 등록(에이전트 프로그램 결) — viewPlugin 없이 viewContract 로 뷰 소유를 발견한다.
  function registerContractProgram() {
    return useProgramRegistry.getState().register("soksak-plugin-agent-claude", {
      id: "claude-contract-test",
      title: "Claude",
      kind: "view",
      view: "content",
      viewContract: CONTRACT,
      command: "claude",
    });
  }

  function viewOf(r: { groupId: string; viewId: string }): { pluginId?: string } & Record<string, unknown> {
    const { groups } = activeLayout();
    return groups.find((g) => g.id === r.groupId)!.views.find((x) => x.id === r.viewId)! as unknown as {
      pluginId?: string;
    } & Record<string, unknown>;
  }

  it("선택 없음 → 첫 활성 구현체(xterm) 뷰 + view id·autorun command 전달", () => {
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r)).toMatchObject({
        kind: "plugin",
        pluginId: XTERM, // 발견 순서 첫 항목 — 특정 id 하드코딩 아님
        view: "content",
        title: "Claude",
        command: "claude",
      });
    } finally {
      dispose();
    }
  });

  it("사용자 선택 → 그 구현체(ghostty)로 해소(엔진 선택)", () => {
    const dispose = registerContractProgram();
    useContractSelection.getState().select(CONTRACT, GHOSTTY);
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(GHOSTTY);
    } finally {
      dispose();
    }
  });

  it("stale 선택(구현체 아님) → 첫 항목으로 폴백(무시)", () => {
    const dispose = registerContractProgram();
    useContractSelection.getState().select(CONTRACT, "soksak-plugin-not-an-impl");
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(XTERM);
    } finally {
      dispose();
    }
  });

  it("비활성(disabled) 구현체는 후보 제외 → 활성 구현체로만 해소", () => {
    usePlugins.setState({
      plugins: {
        [XTERM]: fixtureRuntime(XTERM, [CONTRACT], "disabled"),
        [GHOSTTY]: fixtureRuntime(GHOSTTY, [CONTRACT]),
      },
    });
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(GHOSTTY);
    } finally {
      dispose();
    }
  });

  it("활성 구현체 0 → 뷰 생성 불가(TARGET_NOT_FOUND, 빈 그룹으로 열화)", () => {
    usePlugins.setState({ plugins: {} });
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("TARGET_NOT_FOUND");
    } finally {
      dispose();
    }
  });
});
