// layout.apply 유닛 — 스페이스/패널을 새로 짓는 위계(1차 스페이스·2차 분할)와 미설치 프로그램 건너뛰기,
// hint 상한 준수를 검증한다. 테스트 환경엔 플러그인 로더가 없으므로 useProgramRegistry.register 로
// 최소 프로그램(kind:"view")을 직접 등록한다(emptyPanelContext.test 픽스처 스타일).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import type { ContributedProgram, PluginManifest } from "../plugins/spec";

// dev 프리셋의 첫 패널은 터미널 계약(soksak-spec-plugin-terminal)을 설정 엔진으로 해소한다 — 특정 program id
// 하드코딩이 아니다. 테스트 환경엔 플러그인 로더가 없으므로 계약 구현체를 직접 세운다:
//   ① 엔진 program 을 useProgramRegistry 에 등록,
//   ② implements 를 단 enabled 플러그인을 usePlugins 에 넣어 발견되게 한다.
const XTERM = "soksak-plugin-terminal-xterm";
const XTERM_PROGRAM = "terminal-xterm";
useProgramRegistry.getState().register(XTERM, {
  id: XTERM_PROGRAM,
  kind: "view",
  view: "content",
  title: { en: "Terminal", ko: "터미널" },
} as ContributedProgram);

const terminalEnginePlugins: Record<string, PluginRuntime> = {
  [XTERM]: {
    manifest: { id: XTERM, implements: [{ id: "soksak-spec-plugin-terminal", version: "0.0.1" }] } as unknown as PluginManifest,
    dir: "",
    source: "dev",
    status: "enabled",
  },
};

useSessions.getState().bootstrapFirstProject("/tmp/soksak-layout-apply");
registerCatalog();

const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

// 브라우저 계열 프로그램은 테스트별로 붙였다 뗀다(건너뛰기 경로 검증). register 는 중복 id 를
// 던지므로 afterEach 가 반드시 회수한다.
function registerBrowser(): () => void {
  return useProgramRegistry.getState().register("test-browser-plugin", {
    id: "browser",
    kind: "view",
    view: "web",
    title: { en: "Browser", ko: "브라우저" },
  } as ContributedProgram);
}

let unregBrowser: (() => void) | null = null;

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
  // 터미널 엔진(계약 구현체)을 활성 상태로 되돌린다 — 개별 테스트가 지운 뒤 복구.
  usePlugins.setState({ plugins: { ...terminalEnginePlugins } });
});

afterEach(() => {
  unregBrowser?.();
  unregBrowser = null;
});

function firstProject() {
  const s = useSessions.getState();
  return s.tabs.find((t) => t.id === s.activeId)!;
}

describe("layout.apply", () => {
  it("preset dev — 터미널 엔진(계약)+브라우저가 있으면 2 패널을 한 스페이스로 짓는다", async () => {
    unregBrowser = registerBrowser();
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    const spaces = (r.data as { spaces: { title: string; panels: { program: string }[] }[] }).spaces;
    expect(spaces).toHaveLength(1);
    expect(spaces[0].title).toBe("dev");
    // 터미널 패널은 설정 엔진(계약 해소)의 program 으로 채워진다 — 특정 program id 가정 없음.
    expect(spaces[0].panels.map((p) => p.program)).toEqual([XTERM_PROGRAM, "browser"]);
    expect((r.data as Record<string, unknown>).skipped).toBeUndefined();
  });

  it("preset dev — 브라우저가 없으면 그 패널을 건너뛰고 skipped 에 사유를 담는다", async () => {
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    const data = r.data as {
      spaces: { panels: { program: string }[] }[];
      skipped?: { program: string; reason: string }[];
    };
    expect(data.spaces[0].panels.map((p) => p.program)).toEqual([XTERM_PROGRAM]);
    expect(data.skipped).toBeDefined();
    expect(data.skipped![0].program).toBe("browser");
    expect(typeof data.skipped![0].reason).toBe("string");
    expect(data.skipped![0].reason.length).toBeGreaterThan(0);
  });

  it("preset dev — 활성 터미널 엔진이 없으면 터미널 패널도 건너뛰고 skipped 에 계약을 담는다", async () => {
    unregBrowser = registerBrowser();
    // 활성 터미널 구현체 제거 — 계약 해소가 null 이 되어 터미널 패널을 짓지 못한다.
    usePlugins.setState({ plugins: {} });
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    const data = r.data as {
      spaces: { panels: { program: string }[] }[];
      skipped?: { program: string; reason: string }[];
    };
    // 브라우저는 있으므로 그 패널만 남고, 터미널은 skipped.
    expect(data.spaces[0].panels.map((p) => p.program)).toEqual(["browser"]);
    expect(data.skipped).toBeDefined();
    const terminalSkip = data.skipped!.find((s) => s.program === "soksak-spec-plugin-terminal");
    expect(terminalSkip).toBeDefined();
    expect(terminalSkip!.reason.length).toBeGreaterThan(0);
  });

  it("기본형 문법 — 값 하나(dev)를 preset 위치 인자로 받는다", async () => {
    unregBrowser = registerBrowser();
    const r = await execute("layout.apply", { _: "dev" }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { spaces: unknown[] }).spaces).toHaveLength(1);
  });

  it("preset facets — spaces 인자대로 이름 붙인 스페이스 묶음을 짓는다", async () => {
    const r = await execute(
      "layout.apply",
      {
        preset: "facets",
        spaces: [
          { title: "a", panels: [{ program: XTERM_PROGRAM }] },
          { title: "b", panels: [{ program: XTERM_PROGRAM }, { program: XTERM_PROGRAM, side: "bottom" }] },
        ],
      },
      {},
    );
    expect(r.ok).toBe(true);
    const spaces = (r.data as { spaces: { title: string; panels: unknown[] }[] }).spaces;
    expect(spaces.map((s) => s.title)).toEqual(["a", "b"]);
    expect(spaces[0].panels).toHaveLength(1);
    expect(spaces[1].panels).toHaveLength(2);
    // 2차 패널은 서로 다른 패널 id 다(분할 생성).
    const b = spaces[1].panels as { panelId: string }[];
    expect(b[0].panelId).not.toBe(b[1].panelId);
  });

  it("preset facets — spaces 를 빠뜨리면 INVALID_PARAMS 로 답한다", async () => {
    const r = await execute("layout.apply", { preset: "facets" }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("기존 스페이스를 파괴하지 않는다 — 새 스페이스를 더한다", async () => {
    const before = firstProject().contents.length; // 부트 스페이스 1개
    const beforeId = firstProject().contents[0].id;
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    const after = firstProject().contents;
    expect(after.length).toBe(before + 1);
    // 원래 스페이스가 그대로 남아 있다.
    expect(after.some((c) => c.id === beforeId)).toBe(true);
  });

  it("hint 는 상한 3개를 넘지 않고, 성공 시 제시를 붙인다", async () => {
    unregBrowser = registerBrowser();
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    expect(r.hint).toBeDefined();
    expect(r.hint!.length).toBeGreaterThan(0);
    expect(r.hint!.length).toBeLessThanOrEqual(3);
    // 첫 스페이스로 전환하는 수를 제시한다(실제 spaceId 로 렌더).
    const first = (r.data as { spaces: { spaceId: string }[] }).spaces[0].spaceId;
    expect(r.hint!.some((h) => h.cmd === `sok space.activate ${first}`)).toBe(true);
  });

  it("건너뛴 패널이 있으면 설치 안내 hint 를 앞세운다", async () => {
    const r = await execute("layout.apply", { preset: "dev" }, {});
    expect(r.ok).toBe(true);
    expect(r.hint!.length).toBeLessThanOrEqual(3);
    expect(r.hint!.some((h) => h.cmd === "sok plugin.catalog")).toBe(true);
  });
});
