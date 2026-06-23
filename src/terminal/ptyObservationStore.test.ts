import { describe, it, expect, beforeEach } from "vitest";
import {
  feedPtyOutput,
  registerPtyObservation,
  disposePtyObservation,
  hasPtyObservation,
  registerPtyIo,
  getPtyIo,
  getObservedCwd,
  subscribeObservedCwd,
  subscribeObservedCommandFinished,
  subscribeObservedOutput,
  subscribeAnyCommandStarted,
  subscribeAnyCommandFinished,
  observedRunningCommands,
  pushObservedCwd,
  pushObservedCommandStart,
  pushObservedCommandFinished,
  pushObservedOutput,
  resetPtyObservationStoreForTest,
} from "./ptyObservationStore";

// PTY 관찰 store 계약 — paneId(문자열) 키로 cwd/명령/출력 관찰을 모은다. PTY substrate(누구든
// app.pty 를 구동하는 쪽)가 feedPtyOutput 으로 출력을 먹이면 OSC 가 파싱되어 구독자에게 흐른다.
// app.terminal.* + command.* 이벤트 + idle/status 가 이 store 를 읽는다(코어 터미널 뷰 제거 후에도).

describe("ptyObservationStore", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("OSC 7 출력을 먹이면 그 paneId 의 cwd 가 갱신되고 구독자에 통지", () => {
    registerPtyObservation("p1");
    const seen: string[] = [];
    subscribeObservedCwd("p1", (c) => seen.push(c));
    feedPtyOutput("p1", "\x1b]7;file:///tmp/work\x07");
    expect(getObservedCwd("p1")).toBe("/tmp/work");
    expect(seen).toEqual(["/tmp/work"]);
  });

  it("구독 즉시 현재값이 있으면 1회 통지(폴링 없음)", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]7;file:///a\x07");
    const seen: string[] = [];
    subscribeObservedCwd("p1", (c) => seen.push(c));
    expect(seen).toEqual(["/a"]);
  });

  it("명령 시작(633;E)→전역 구독자에 paneId·명령라인·cwd 통지 + runningCommands 스냅샷", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]633;P;Cwd=/proj\x07");
    const starts: { paneId: string; cmd: string; cwd: string | null }[] = [];
    subscribeAnyCommandStarted((paneId, cmd, cwd) =>
      starts.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("p1", "\x1b]633;E;npm%20test\x07");
    expect(starts).toEqual([{ paneId: "p1", cmd: "npm test", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([
      { paneId: "p1", commandLine: "npm test", cwd: "/proj" },
    ]);
  });

  it("명령 종료(133;D)→pane 구독 + 전역 구독(끝난 명령라인·cwd 동반) + runningCommands clear", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]633;P;Cwd=/proj\x07");
    feedPtyOutput("p1", "\x1b]633;E;build\x07");
    let paneFinished = 0;
    subscribeObservedCommandFinished("p1", () => paneFinished++);
    const fins: {
      paneId: string;
      cmd: string | null | undefined;
      cwd: string | null | undefined;
    }[] = [];
    subscribeAnyCommandFinished((paneId, cmd, cwd) =>
      fins.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("p1", "\x1b]133;D;0\x07");
    expect(paneFinished).toBe(1);
    expect(fins).toEqual([{ paneId: "p1", cmd: "build", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([]);
  });

  it("출력이 흐르면 output 구독자에 통지(라이브 스트림·입력 검증용)", () => {
    registerPtyObservation("p1");
    let n = 0;
    subscribeObservedOutput("p1", () => n++);
    feedPtyOutput("p1", "some output\n");
    feedPtyOutput("p1", "more\n");
    expect(n).toBe(2);
  });

  it("dispose 후에는 통지 안 하고 cwd 스냅샷도 사라짐(누수 차단)", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]7;file:///x\x07");
    let n = 0;
    subscribeObservedCwd("p1", () => n++);
    disposePtyObservation("p1");
    feedPtyOutput("p1", "\x1b]7;file:///y\x07"); // dispose 후 — 무시
    expect(getObservedCwd("p1")).toBeUndefined();
    expect(n).toBe(1); // 등록 즉시 1회만(현재값 /x)
  });

  it("두 pane 은 서로 독립(키 격리)", () => {
    registerPtyObservation("a");
    registerPtyObservation("b");
    feedPtyOutput("a", "\x1b]7;file:///a-dir\x07");
    feedPtyOutput("b", "\x1b]7;file:///b-dir\x07");
    expect(getObservedCwd("a")).toBe("/a-dir");
    expect(getObservedCwd("b")).toBe("/b-dir");
  });

  it("미등록 paneId 에 feed 해도 안전(no-op)", () => {
    expect(() => feedPtyOutput("ghost", "\x1b]7;file:///g\x07")).not.toThrow();
    expect(getObservedCwd("ghost")).toBeUndefined();
  });

  // hasPtyObservation = "이 id 가 PTY substrate 를 구동하는가"(터미널 generic 신호 —
  // pluginId 무관). 파일트리 cwdPaneOf 가 코어/플러그인 터미널을 구분 없이 따라가는 데 쓴다.
  it("hasPtyObservation 은 등록된 paneId 에만 true, dispose 후 false", () => {
    expect(hasPtyObservation("p1")).toBe(false);
    registerPtyObservation("p1");
    expect(hasPtyObservation("p1")).toBe(true);
    expect(hasPtyObservation("p2")).toBe(false);
    disposePtyObservation("p1");
    expect(hasPtyObservation("p1")).toBe(false);
  });

  // PTY IO 핸들러 등록(GAP2) — pty-driver(코어 호스트/플러그인 터미널)가 paneId 키로
  // readBuffer/sendInput 을 등록한다. app.terminal.readBuffer/sendText 가 이걸 우선 쓴다.
  it("registerPtyIo 로 등록한 IO 를 getPtyIo 로 조회, dispose 시 회수", () => {
    expect(getPtyIo("p1")).toBeUndefined();
    const reads: (number | undefined)[] = [];
    const sends: string[] = [];
    const off = registerPtyIo("p1", {
      readBuffer: (lines) => {
        reads.push(lines);
        return "buffer-text";
      },
      sendInput: (data) => {
        sends.push(data);
      },
    });
    const io = getPtyIo("p1");
    expect(io?.readBuffer(5)).toBe("buffer-text");
    expect(reads).toEqual([5]);
    io?.sendInput("ls\r");
    expect(sends).toEqual(["ls\r"]);
    off();
    expect(getPtyIo("p1")).toBeUndefined();
  });

  it("registerPtyIo 는 미등록 관찰이어도 자체적으로 등록(선등록 불요) + 키 격리", () => {
    registerPtyIo("a", { readBuffer: () => "A", sendInput: () => {} });
    registerPtyIo("b", { readBuffer: () => "B", sendInput: () => {} });
    expect(getPtyIo("a")?.readBuffer()).toBe("A");
    expect(getPtyIo("b")?.readBuffer()).toBe("B");
    disposePtyObservation("a");
    expect(getPtyIo("a")).toBeUndefined();
    expect(getPtyIo("b")?.readBuffer()).toBe("B");
  });

  // 코어 터미널 뷰 producer 경로 — 이미 파싱된 관찰을 직접 푸시(raw 재파싱 없이).
  it("push* 경로도 동일 store 구독자에 흐른다(코어 producer)", () => {
    registerPtyObservation("core");
    const cwds: string[] = [];
    subscribeObservedCwd("core", (c) => cwds.push(c));
    const starts: string[] = [];
    subscribeAnyCommandStarted((_p, cmd) => starts.push(cmd));
    let paneFin = 0;
    subscribeObservedCommandFinished("core", () => paneFin++);
    const fins: (string | null | undefined)[] = [];
    subscribeAnyCommandFinished((_p, cmd) => {
      fins.push(cmd);
    });
    let out = 0;
    subscribeObservedOutput("core", () => out++);

    pushObservedCwd("core", "/core/dir");
    pushObservedCommandStart("core", "make build");
    pushObservedOutput("core");
    pushObservedCommandFinished("core");

    expect(cwds).toEqual(["/core/dir"]);
    expect(getObservedCwd("core")).toBe("/core/dir");
    expect(starts).toEqual(["make build"]);
    expect(out).toBe(1);
    expect(paneFin).toBe(1);
    expect(fins).toEqual(["make build"]);
    expect(observedRunningCommands()).toEqual([]);
  });
});
