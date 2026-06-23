// PTY 관찰 파서 — 셸 통합 OSC 시퀀스를 raw PTY 출력에서 직접 파싱한다(xterm Terminal 비의존).
//
// [원칙] 관찰(cwd·명령 시작/종료)은 터미널-프로토콜 레벨 = 범용 substrate 이지 터미널-기능-뷰가
// 아니다. 그러므로 PTY 바이트를 흘리는 누구든(코어 createTerminal 이든 터미널 플러그인이든) 이
// 파서에 출력을 먹이면 동일한 관찰을 얻는다. xterm 의 parser.registerOscHandler 에 의존하던
// shellIntegration.ts 의 OSC 파싱 의미론(OSC 7 / 133 / 633)을 바이트 스트림 파서로 옮긴 것이다.
//
// 파싱 대상:
//   - OSC 7  : file URI → cwd
//   - OSC 133: A 프롬프트시작 / D;exit 명령종료(표준 semantic prompt)
//   - OSC 633: A/D 동일, P;Cwd= 로 cwd, E;<percent-encoded> 명령라인
// 종결자: BEL(0x07) 또는 ST(ESC '\\').

export interface PtyObservationCallbacks {
  /** cwd 가 실제로 바뀔 때만 통지(OSC 7 / 633;P). */
  onCwd?: (cwd: string) => void;
  /** 명령 시작(OSC 633;E — 셸 preexec 가 보고한 명령라인). */
  onCommandStart?: (commandLine: string) => void;
  /** 명령 종료(OSC 133/633 D). */
  onCommandFinished?: () => void;
}

export interface PtyObservationParser {
  /** PTY 출력 청크(문자열 또는 raw 바이트)를 먹인다. OSC 는 청크 경계를 넘어 누적된다. */
  write: (chunk: string | Uint8Array) => void;
  /** 현재 cwd 스냅샷(미확인 시 undefined). */
  getCwd: () => string | undefined;
}

const BEL = 0x07;
const ESC = 0x1b;

// OSC 페이로드 누적 상태기. ESC ] 진입 → BEL 또는 ESC \ 까지 본문 수집.
// 비-OSC ESC 시퀀스(CSI 등)는 흘려보낸다 — 우리는 OSC 만 관찰한다.
type State = "text" | "esc" | "osc" | "osc-esc";

export function createPtyObservationParser(
  cb: PtyObservationCallbacks,
): PtyObservationParser {
  const decoder = new TextDecoder("utf-8");
  let state: State = "text";
  let osc = "";
  let cwd: string | undefined;

  const setCwd = (next: string) => {
    if (!next || next === cwd) return;
    cwd = next;
    cb.onCwd?.(next);
  };

  const setCwdFromUri = (uri: string) => {
    // file://host/path → path
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
    if (!m) return;
    let path: string;
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      path = m[1];
    }
    setCwd(path);
  };

  // 누적된 OSC 본문(번호 제외) 처리 — shellIntegration.ts 의 핸들러와 동일 의미론.
  const handleOsc = (data: string) => {
    const numEnd = data.indexOf(";");
    const num = numEnd === -1 ? data : data.slice(0, numEnd);
    const body = numEnd === -1 ? "" : data.slice(numEnd + 1);

    if (num === "7") {
      setCwdFromUri(body);
      return;
    }
    if (num === "133" || num === "633") {
      const semi = body.indexOf(";");
      const cmd = semi === -1 ? body : body.slice(0, semi);
      const rest = semi === -1 ? "" : body.slice(semi + 1);
      if (cmd === "D") {
        cb.onCommandFinished?.();
      } else if (num === "633" && cmd === "P") {
        const m = /Cwd=([^;]*)/.exec(rest);
        if (m) setCwd(m[1]);
      } else if (num === "633" && cmd === "E") {
        let line: string;
        try {
          line = decodeURIComponent(rest);
        } catch {
          line = rest;
        }
        if (line) cb.onCommandStart?.(line);
      }
      // cmd === "A" (프롬프트 시작) 등은 관찰 대상 아님 — 무시.
    }
  };

  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      switch (state) {
        case "text":
          if (c === ESC) state = "esc";
          break;
        case "esc":
          // ESC ] = OSC 진입. 그 외(CSI '[' 등)는 본문이 아니라 한 글자만 보고 text 복귀해도
          // 무방하다 — OSC 가 아니므로 관찰 대상이 아니고, 후속 바이트는 일반 흐름으로 흘러간다.
          if (c === 0x5d /* ] */) {
            state = "osc";
            osc = "";
          } else {
            state = "text";
          }
          break;
        case "osc":
          if (c === BEL) {
            handleOsc(osc);
            osc = "";
            state = "text";
          } else if (c === ESC) {
            // ST 후보(ESC \) — 다음 글자가 '\' 면 종결.
            state = "osc-esc";
          } else {
            osc += s[i];
          }
          break;
        case "osc-esc":
          if (c === 0x5c /* \\ */) {
            handleOsc(osc);
            osc = "";
            state = "text";
          } else {
            // ESC 가 ST 가 아니었다 — ESC 와 현재 글자를 본문에 흡수하고 OSC 계속.
            // (실무상 OSC 본문 중 단독 ESC 는 드물지만 안전하게 처리.)
            osc += "\x1b" + s[i];
            state = "osc";
          }
          break;
      }
    }
  };

  return {
    write: (chunk) => {
      const s =
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      feed(s);
    },
    getCwd: () => cwd,
  };
}
