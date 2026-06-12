import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onPluginEvent,
  startPluginHooks,
  type PluginEventMap,
} from "./hooks";
import { useSessions } from "../state/sessions";

// startPluginHooks 의 sessions diff 가 rAF 로 coalesce 되는지(원칙 4·5,
// docs/PERFORMANCE.md), coalesce 후에도 이벤트 시맨틱이 보존되는지 검증한다.
// rAF 를 수동 제어해 "한 프레임"을 명시적으로 진행시킨다.

let queue: FrameRequestCallback[] = [];
let nextId = 1;

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function frame() {
  const cbs = queue;
  queue = [];
  for (const cb of cbs) cb(performance.now());
}

type Ev = { event: keyof PluginEventMap; payload: unknown };

describe("startPluginHooks — sessions diff coalescing", () => {
  it("프레임 내 다중 쓰기(리사이즈 스톰)는 diff 1회로 합쳐지고, 시맨틱 이벤트는 보존된다", () => {
    // startPluginHooks 는 모듈 수명당 1회(started 가드) — 이 테스트 파일에서 1회 기동.
    startPluginHooks();
    frame(); // 기동 직전 상태로 prev 스냅샷 정착

    const events: Ev[] = [];
    const subs = (
      ["project.changed", "view.activated", "file.opened", "file.closed"] as const
    ).map((e) =>
      onPluginEvent(e, (payload) => events.push({ event: e, payload })),
    );

    const s = useSessions.getState();
    const created = s.addProject({ alias: "perf", root: "/tmp/perf-test" });
    expect(created.ok).toBe(true);

    if (!created.ok) throw new Error("addProject 실패");
    // 같은 프레임 안: 프로젝트 추가 + 분할 + 리사이즈 스톰(120회) + 파일 열기.
    const projectId = created.projectId;
    const split = useSessions
      .getState()
      .splitWithNewView(projectId, created.groupId, "right");
    expect(split.ok).toBe(true);

    // 분할 노드 id 를 찾아 리사이즈 스톰.
    const tab = useSessions.getState().tabs.find((t) => t.id === projectId)!;
    const content = tab.contents[0];
    const splitId =
      content.layout.type === "split" ? content.layout.id : null;
    expect(splitId).not.toBeNull();
    for (let i = 0; i < 120; i++) {
      const a = 0.3 + (i % 40) / 100;
      useSessions.getState().resizeSplit(projectId, splitId!, [a, 1 - a]);
    }

    const opened = useSessions
      .getState()
      .openFileView(projectId, "/tmp/perf-test/a.txt");
    expect(opened.ok).toBe(true);

    // 아직 프레임 전 — 이벤트 0건(쓰기마다 diff 돌았다면 이미 다수 발화).
    expect(events.length).toBe(0);

    frame(); // 한 프레임 진행 → coalesce 된 diff 1회

    // 시맨틱 보존: 프로젝트 활성 변경 1회 + 파일 열림 1회 + 뷰 활성 1회.
    // 리사이즈 120회는 어떤 이벤트도 만들지 않는다.
    const byEvent = (e: keyof PluginEventMap) =>
      events.filter((x) => x.event === e);
    expect(byEvent("project.changed").length).toBe(1);
    expect(byEvent("file.opened").length).toBe(1);
    expect(byEvent("file.opened")[0].payload).toMatchObject({
      path: "/tmp/perf-test/a.txt",
    });
    expect(byEvent("view.activated").length).toBe(1);
    expect(byEvent("file.closed").length).toBe(0);

    // 추가 프레임에서 중복 발화 없음.
    events.length = 0;
    frame();
    expect(events.length).toBe(0);

    for (const d of subs) d.dispose();
  });

  it("프레임 사이의 쓰기는 각각 diff 된다(열림→닫힘이 별개 프레임이면 둘 다 발화)", () => {
    const events: Ev[] = [];
    const subOpen = onPluginEvent("file.opened", (p) =>
      events.push({ event: "file.opened", payload: p }),
    );
    const subClose = onPluginEvent("file.closed", (p) =>
      events.push({ event: "file.closed", payload: p }),
    );

    const created = useSessions
      .getState()
      .addProject({ alias: "perf2", root: "/tmp/perf-test" });
    expect(created.ok).toBe(true);
    frame(); // 프로젝트 추가 이벤트를 먼저 소화
    events.length = 0;

    const tab = useSessions.getState().tabs.find((t) => t.title === "perf2")!;
    const opened = useSessions
      .getState()
      .openFileView(tab.id, "/tmp/perf-test/b.txt");
    expect(opened.ok).toBe(true);
    frame();
    expect(events.filter((e) => e.event === "file.opened").length).toBe(1);

    if (opened.ok) {
      useSessions.getState().closeView(tab.id, opened.viewId);
    }
    frame();
    expect(events.filter((e) => e.event === "file.closed").length).toBe(1);

    subOpen.dispose();
    subClose.dispose();
  });
});
