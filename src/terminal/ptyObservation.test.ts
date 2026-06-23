import { describe, it, expect } from "vitest";
import { createPtyObservationParser } from "./ptyObservation";

// PTY 관찰 파서 계약 — 셸 통합 OSC 시퀀스(OSC 7 cwd, OSC 133/633 명령 마커)를
// raw PTY 출력 문자열/바이트에서 직접 파싱한다(xterm Terminal 비의존). 이게 깨지면
// 코어 터미널 뷰 제거 후 app.terminal.* + command.* 이벤트가 전부 무너지므로 회귀선.

describe("ptyObservation — OSC 7 cwd", () => {
  it("OSC 7 file URI 를 cwd 로 디코드", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;file:///tmp/x\x07");
    expect(cwds).toEqual(["/tmp/x"]);
  });

  it("percent-encoded·비ASCII 경로 왕복 보존", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write(`\x1b]7;file://host${encodeURI("/tmp/my project/héllo")}\x07`);
    expect(cwds).toEqual(["/tmp/my project/héllo"]);
  });

  it("같은 cwd 반복은 통지 안 함(변경 시에만)", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;file:///a\x07");
    p.write("\x1b]7;file:///a\x07");
    p.write("\x1b]7;file:///b\x07");
    expect(cwds).toEqual(["/a", "/b"]);
  });

  it("getCwd 스냅샷 노출", () => {
    const p = createPtyObservationParser({});
    expect(p.getCwd()).toBeUndefined();
    p.write("\x1b]7;file:///tmp/z\x07");
    expect(p.getCwd()).toBe("/tmp/z");
  });
});

describe("ptyObservation — OSC 633 markers", () => {
  it("OSC 633;E percent-encoded 명령라인을 디코드해 onCommandStart 통지", () => {
    const starts: string[] = [];
    const p = createPtyObservationParser({ onCommandStart: (c) => starts.push(c) });
    p.write("\x1b]633;E;claude%20--model%20sonnet\x07");
    expect(starts).toEqual(["claude --model sonnet"]);
  });

  it("OSC 633;P;Cwd= 로 cwd 갱신", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]633;P;Cwd=/srv/app\x07");
    expect(cwds).toEqual(["/srv/app"]);
  });

  it("OSC 633;D 는 onCommandFinished 통지", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]633;D;0\x07");
    expect(finished).toBe(1);
  });
});

describe("ptyObservation — OSC 133 markers (standard)", () => {
  it("OSC 133;D 는 onCommandFinished 통지", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;D;0\x07");
    expect(finished).toBe(1);
  });

  it("OSC 133;A(프롬프트 시작) 는 종료 통지 아님", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;A\x07");
    expect(finished).toBe(0);
  });

  it("ST(ESC backslash) 종결도 BEL 과 동일 취급", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;D;0\x1b\\");
    expect(finished).toBe(1);
  });
});

describe("ptyObservation — 청크 경계 / 혼합 스트림", () => {
  it("OSC 시퀀스가 청크 사이로 쪼개져도 파싱(스트리밍)", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;fil");
    p.write("e:///split/path");
    p.write("\x07");
    expect(cwds).toEqual(["/split/path"]);
  });

  it("일반 출력 텍스트는 무시하고 임베드된 OSC 만 처리", () => {
    const cwds: string[] = [];
    const starts: string[] = [];
    const p = createPtyObservationParser({
      onCwd: (c) => cwds.push(c),
      onCommandStart: (c) => starts.push(c),
    });
    p.write("hello\x1b]633;E;ls%20-la\x07world\x1b]7;file:///d\x07more");
    expect(starts).toEqual(["ls -la"]);
    expect(cwds).toEqual(["/d"]);
  });

  it("Uint8Array 바이트 입력도 동일 처리(UTF-8 디코드)", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    const bytes = new TextEncoder().encode("\x1b]7;file:///bytes/path\x07");
    p.write(bytes);
    expect(cwds).toEqual(["/bytes/path"]);
  });

  it("ESC 가 OSC 가 아니어도(CSI 등) 안전하게 흘려보냄", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    // CSI 커서 이동 후 OSC 7 — CSI 는 무시, OSC 만 잡는다.
    p.write("\x1b[2J\x1b[H\x1b]7;file:///after/csi\x07");
    expect(cwds).toEqual(["/after/csi"]);
  });
});
