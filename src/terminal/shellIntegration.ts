import type { IMarker, Terminal } from "@xterm/xterm";

// 셸 통합 consume 측: OSC 133(표준)·633(editor)·7(cwd) 을 파싱해
//  - 각 명령의 프롬프트 줄에 거터 데코레이션(성공=초록 / 실패=빨강)
//  - 현재 작업 디렉토리(cwd) 추적
// 을 제공한다. emit 은 셸 통합 스크립트(OSC 133/7)가 담당.

export interface ShellIntegration {
  /** 현재 작업 디렉토리(OSC 7 / 633;P 로 갱신). 미확인 시 undefined. */
  getCwd: () => string | undefined;
  dispose: () => void;
}

const COLOR_SUCCESS = "#1db954";
const COLOR_ERROR = "#f14c4c";

export function setupShellIntegration(term: Terminal): ShellIntegration {
  let cwd: string | undefined;
  // 현재 명령의 프롬프트 줄 마커(A 에서 생성, D 에서 데코레이션 후 해제).
  let promptMarker: IMarker | undefined;
  const disposers: Array<() => void> = [];

  const markPromptStart = () => {
    // 같은 명령에서 A 가 여러 번 와도 최신 줄만 추적.
    promptMarker = term.registerMarker(0) ?? undefined;
  };

  const finishCommand = (exitRaw: string | undefined) => {
    if (!promptMarker) return;
    const exit = Number.parseInt(exitRaw ?? "0", 10);
    decorate(term, promptMarker, Number.isFinite(exit) ? exit : 0);
    promptMarker = undefined;
  };

  const setCwdFromUri = (uri: string) => {
    // file://host/path → path
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
    if (!m) return;
    try {
      cwd = decodeURIComponent(m[1]);
    } catch {
      cwd = m[1];
    }
  };

  // OSC 133 (표준 semantic prompt): A 프롬프트시작 / D;exit 명령종료.
  disposers.push(
    term.parser.registerOscHandler(133, (data) => {
      const semi = data.indexOf(";");
      const cmd = semi === -1 ? data : data.slice(0, semi);
      const rest = semi === -1 ? "" : data.slice(semi + 1);
      if (cmd === "A") {
        markPromptStart();
      } else if (cmd === "D") {
        finishCommand(rest);
      }
      return true;
    }).dispose,
  );

  // OSC 633 (editor): A/D 는 위와 동일, P;Cwd= 로 cwd, E 는 명령 텍스트(소비만).
  disposers.push(
    term.parser.registerOscHandler(633, (data) => {
      const semi = data.indexOf(";");
      const cmd = semi === -1 ? data : data.slice(0, semi);
      const rest = semi === -1 ? "" : data.slice(semi + 1);
      if (cmd === "A") {
        markPromptStart();
      } else if (cmd === "D") {
        finishCommand(rest);
      } else if (cmd === "P") {
        const m = /Cwd=([^;]*)/.exec(rest);
        if (m) cwd = m[1];
      }
      return true;
    }).dispose,
  );

  // OSC 7: cwd 보고(file URI). xterm 기본 처리가 없으므로 우리가 소비.
  disposers.push(
    term.parser.registerOscHandler(7, (data) => {
      setCwdFromUri(data);
      return true;
    }).dispose,
  );

  return {
    getCwd: () => cwd,
    dispose: () => {
      promptMarker?.dispose();
      disposers.forEach((d) => d());
    },
  };
}

// 프롬프트 줄 좌측 거터에 얇은 색 막대(성공/실패) 데코레이션.
function decorate(term: Terminal, marker: IMarker, exitCode: number): void {
  const decoration = term.registerDecoration({ marker, x: 0, width: 1 });
  if (!decoration) return;
  decoration.onRender((el) => {
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.width = "2px";
    el.style.height = "100%";
    el.style.backgroundColor = exitCode === 0 ? COLOR_SUCCESS : COLOR_ERROR;
    el.style.pointerEvents = "none";
  });
}
