import { describe, expect, it } from "vitest";
import {
  emitPluginEvent,
  onPluginEvent,
  startPluginHooks,
  type PluginEventMap,
} from "./hooks";
import { useSessions } from "../state/sessions";

// startPluginHooks 의 sessions diff 가 마이크로태스크로 coalesce 되는지
// (같은 동기 burst = diff 1회), coalesce 후에도 이벤트 시맨틱이 보존되는지
// 검증한다. rAF 가 아닌 이유: WebKit 은 가려진(occluded) 창에서 rAF 를
// 정지시켜 원격(sok/MCP) 조작 중 이벤트가 무기한 지연되는 사고가 실측됨 —
// diff 는 렌더와 무관하므로 마이크로태스크가 옳은 정렬 지점이다.

// 대기 중인 마이크로태스크(scheduleSessionsDiff 의 queueMicrotask)를 소화.
async function flush() {
  await Promise.resolve();
}

type Ev = { event: keyof PluginEventMap; payload: unknown };

describe("startPluginHooks — sessions diff coalescing", () => {
  it("동기 burst 다중 쓰기(리사이즈 스톰)는 diff 1회로 합쳐지고, 시맨틱 이벤트는 보존된다", async () => {
    // startPluginHooks 는 모듈 수명당 1회(started 가드) — 이 테스트 파일에서 1회 기동.
    startPluginHooks();
    await flush(); // 기동 직전 상태로 prev 스냅샷 정착

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
    // 같은 동기 burst 안: 프로젝트 추가 + 분할 + 리사이즈 스톰(120회) + 파일 열기.
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

    // 아직 마이크로태스크 전 — 이벤트 0건(쓰기마다 diff 돌았다면 이미 다수 발화).
    expect(events.length).toBe(0);

    await flush(); // 마이크로태스크 소화 → coalesce 된 diff 1회

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

    // 추가 양보에서 중복 발화 없음.
    events.length = 0;
    await flush();
    expect(events.length).toBe(0);

    for (const d of subs) d.dispose();
  });

  it("burst 사이의 쓰기는 각각 diff 된다(열림→닫힘이 별개 burst 면 둘 다 발화)", async () => {
    const events: Ev[] = [];
    const subOpen = onPluginEvent("file.opened", (p) =>
      events.push({ event: "file.opened", payload: p }),
    );
    const subClose = onPluginEvent("file.closed", (p) =>
      events.push({ event: "file.closed", payload: p }),
    );

    const created = useSessions
      .getState()
      // P5(같은 root 중복 금지) — 첫 테스트와 다른 root 여야 새 프로젝트가 생긴다.
      .addProject({ alias: "perf2", root: "/tmp/perf-test-2" });
    expect(created.ok).toBe(true);
    await flush(); // 프로젝트 추가 이벤트를 먼저 소화
    events.length = 0;

    const tab = useSessions.getState().tabs.find((t) => t.title === "perf2")!;
    const opened = useSessions
      .getState()
      .openFileView(tab.id, "/tmp/perf-test/b.txt");
    expect(opened.ok).toBe(true);
    await flush();
    expect(events.filter((e) => e.event === "file.opened").length).toBe(1);

    if (opened.ok) {
      useSessions.getState().closeView(tab.id, opened.viewId);
    }
    await flush();
    expect(events.filter((e) => e.event === "file.closed").length).toBe(1);

    subOpen.dispose();
    subClose.dispose();
  });
});

describe("window.live-resize 이벤트", () => {
  // 코어 네이티브 드래그 신호(window-live-resize)를 플러그인 events 채널로 노출한다.
  // 터미널/브라우저 플러그인이 드래그 중 무거운 작업을 멈추고 끝에 1회 스냅하기 위한
  // 단일 채널 — app.focus(window-focus 중계)와 동형. 권한 불요(비민감 라이프사이클).
  it("active 토글(시작=true / 끝=false)을 순서대로 전달한다", () => {
    const got: boolean[] = [];
    const d = onPluginEvent("window.live-resize", (p) => got.push(p.active));
    emitPluginEvent("window.live-resize", { active: true });
    emitPluginEvent("window.live-resize", { active: false });
    d.dispose();
    // 해지 후 이벤트는 받지 않는다.
    emitPluginEvent("window.live-resize", { active: true });
    expect(got).toEqual([true, false]);
  });
});

describe("layout.resize-gesture 이벤트", () => {
  // 패널 디바이더 드래그 제스처(시작/끝)를 플러그인 events 채널로 노출한다.
  // window.live-resize(창 가장자리)와 동형의 레이아웃-내부 제스처 채널 — 네이티브
  // 표면 제공자(브라우저)가 드래그 중 bounds 커밋을 유예하고 freeze-frame 을 띄우는
  // 근거 신호. 권한 불요(비민감 라이프사이클).
  it("active 토글(드래그 시작=true / 끝=false)을 순서대로 전달한다", () => {
    const got: boolean[] = [];
    const d = onPluginEvent("layout.resize-gesture", (p) => got.push(p.active));
    emitPluginEvent("layout.resize-gesture", { active: true });
    emitPluginEvent("layout.resize-gesture", { active: false });
    d.dispose();
    emitPluginEvent("layout.resize-gesture", { active: true });
    expect(got).toEqual([true, false]);
  });
});

describe("layout.reflow 이벤트", () => {
  // 콘텐츠 탭 전환 등으로 콘텐츠 슬롯이 파킹/언파킹된 뒤 코어(App.tsx)가 React 커밋 직후
  // (useLayoutEffect) 발화하는 채널. 네이티브 표면 제공자(브라우저)가 최종 앵커 rect 로 bounds 를
  // 1회 재스냅하는 신호 — 파킹은 위치 이동(크기 무변)이라 ResizeObserver 가 못 잡고, 전환 신호
  // (view.activated)는 store diff 마이크로태스크라 커밋 전이라 옛 위치를 잰다. 이 채널이 커밋 후
  // 단일 반응의 근거. 이게 없으면 첫 클릭에 webview 가 안 따라오고 둘째 클릭이 필요했다.
  it("activeSheetId payload 를 전달하고, 해지 후엔 받지 않는다", () => {
    const got: (string | null)[] = [];
    const d = onPluginEvent("layout.reflow", (p) => got.push(p.activeSheetId));
    emitPluginEvent("layout.reflow", { activeSheetId: "c1" });
    emitPluginEvent("layout.reflow", { activeSheetId: "c2" });
    d.dispose();
    emitPluginEvent("layout.reflow", { activeSheetId: "c3" });
    expect(got).toEqual(["c1", "c2"]);
  });
});
