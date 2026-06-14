import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { setupShellIntegration } from "./shellIntegration";

// 셸 통합 소켓 계약 고정: 셸(.zsh)이 보내는 OSC 시퀀스를 프런트가 정확히 파싱해
// command.started 의 원천(onCommandStart)·cwd 를 노출하는지. 이 계약이 깨지면
// claude-GUI 등 소켓 소비 플러그인이 전부 무너지므로 회귀 방지선으로 둔다.

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe("shellIntegration — command.started 소켓", () => {
  it("OSC 633;E 의 percent-encoded 명령라인을 디코드해 onCommandStart 통지", async () => {
    const term = new Terminal();
    const si = setupShellIntegration(term);
    const seen: string[] = [];
    si.onCommandStart((cmd) => seen.push(cmd));

    // .zsh __vsterm_osc633E 가 보내는 형태: \e]633;E;<percent-encoded>\a
    await write(term, "\x1b]633;E;claude%20--model%20sonnet\x07");
    expect(seen).toEqual(["claude --model sonnet"]);

    si.dispose();
    term.dispose();
  });

  it("비ASCII·공백 경로/인자도 percent 왕복 보존", async () => {
    const term = new Terminal();
    const si = setupShellIntegration(term);
    const seen: string[] = [];
    si.onCommandStart((cmd) => seen.push(cmd));

    const line = "claude /tmp/my project --note=héllo";
    await write(term, `\x1b]633;E;${encodeURIComponent(line)}\x07`);
    expect(seen).toEqual([line]);

    si.dispose();
    term.dispose();
  });

  it("dispose 후에는 더 통지하지 않는다(누수 차단)", async () => {
    const term = new Terminal();
    const si = setupShellIntegration(term);
    let n = 0;
    si.onCommandStart(() => n++);
    si.dispose();
    await write(term, "\x1b]633;E;claude\x07");
    expect(n).toBe(0);
    term.dispose();
  });

  it("cwd(OSC 7) 와 명령 종료(OSC 133;D) 기존 동작 유지", async () => {
    const term = new Terminal();
    const si = setupShellIntegration(term);
    let finished = 0;
    si.onCommandFinished(() => finished++);

    await write(term, "\x1b]7;file:///tmp/x\x07");
    expect(si.getCwd()).toBe("/tmp/x");

    // 133;A 없이 D 만 — 데코레이션 경로 없이 onCommandFinished 만 검증.
    await write(term, "\x1b]133;D;0\x07");
    expect(finished).toBe(1);

    si.dispose();
    term.dispose();
  });
});
