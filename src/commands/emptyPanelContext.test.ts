// 빈 패널(뷰 0개)이 활성일 때의 컨텍스트 해석 — 실측 재현: 활성 패널의 뷰를 모두 옮기거나 닫아
// views 가 비면 activeChain 이 view=undefined 인 Location 을 돌려주고, state.context 가
// INTERNAL(TypeError) 로 죽었다. 계약: 해석 불가는 구조적 오류(TARGET_NOT_FOUND)로 답한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { allGroups, useSessions } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import type { ContributedProgram } from "../plugins/spec";

// view.open 검증용 최소 프로그램 — 테스트 환경엔 플러그인 로더가 없어 직접 등록한다.
useProgramRegistry
  .getState()
  .register("test-plugin", {
    id: "terminal",
    kind: "view",
    view: "term",
    title: { en: "Terminal", ko: "터미널" },
  } as ContributedProgram);

useSessions.getState().bootstrapFirstProject("/tmp/soksak-emptypanel");
registerCatalog();
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

/** 활성 스페이스의 활성 패널을 뷰 0개로 만든다(실측 상태의 재현). */
function emptyActivePanel(): void {
  const tabs = structuredClone(useSessions.getState().tabs);
  const project = tabs.find((t) => t.id === useSessions.getState().activeId)!;
  const content =
    project.contents.find((c) => c.id === project.activeContentId) ?? project.contents[0];
  const groups = allGroups(content.layout);
  const g = groups.find((x) => x.id === content.activeGroupId) ?? groups[0];
  g.views = [];
  g.activeViewId = "";
  useSessions.setState({ tabs });
}

/** 정상 사슬 재현 — 활성 패널에 뷰 하나를 연다(부트스트랩은 테스트 환경에서 뷰를 만들지 않는다). */
function openOneView(): void {
  const s = useSessions.getState();
  const r = s.openPluginView(s.activeId, "p", "test-view", "T");
  if (!r.ok) throw new Error("openPluginView 실패");
}

describe("빈 패널 컨텍스트", () => {
  it("state.context 는 죽지 않고 패널까지의 위치를 답한다(viewId 없음)", async () => {
    emptyActivePanel();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ projectId: expect.any(String), panelId: expect.any(String) });
    expect((r.data as Record<string, unknown>).viewId).toBeUndefined();
  });

  it("빈 패널에도 view.open 으로 뷰를 추가할 수 있다", async () => {
    emptyActivePanel();
    const r = await execute("view.open", { program: "terminal" }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ panelId: expect.any(String), viewId: expect.any(String) });
  });

  it("빈 패널에서 view.maximize 는 구조적 오류로 답한다(뷰 없음)", async () => {
    emptyActivePanel();
    const r = await execute("view.maximize", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });

  it("정상 상태에서는 위치 사슬을 돌려준다", async () => {
    openOneView();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: expect.any(String),
      spaceId: expect.any(String),
      panelId: expect.any(String),
      viewId: expect.any(String),
    });
  });
});

describe("panel.split 기본 program 없음", () => {
  it("program 미지정 시 빈 패널을 만든다 — 코어는 터미널을 기본으로 심지 않는다", async () => {
    const r = await execute("panel.split", { side: "right" }, {});
    expect(r.ok).toBe(true);
    // 새 패널은 생기되(panelId) 뷰는 없다(viewId 부재 = 블랭크). 코어 program-무지.
    expect(r.data).toMatchObject({ panelId: expect.any(String) });
    expect((r.data as Record<string, unknown>).viewId).toBeUndefined();
  });

  it("program 을 명시하면 그 뷰로 채운다(블랭크 아님)", async () => {
    const r = await execute("panel.split", { side: "right", program: "terminal" }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      panelId: expect.any(String),
      viewId: expect.any(String),
    });
  });
});
