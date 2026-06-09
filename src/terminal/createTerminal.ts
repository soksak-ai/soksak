import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

import { WebkitImeAddon } from "../vendor/xterm-addon-webkit-ime";
import { darkTheme } from "./theme";

// editor FlowControlConstants.CharCountAckSize 와 동일.
const FLOW_ACK_SIZE = 5000;

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
}

export interface TerminalHandle {
  terminal: Terminal;
  /** 백엔드 PTY 세션 id (스폰 완료 후 채워짐). */
  readonly id: () => number;
  /** 컨테이너 크기에 맞춰 fit 후 PTY 에 크기 전파. */
  fit: () => void;
  focus: () => void;
  dispose: () => void;
}

/**
 * editor xtermTerminal.ts 패턴을 따른 터미널 생성:
 * - 폰트 로드 완료 후 open (셀 메트릭 정확)
 * - WebGL 렌더러 + onContextLoss 폴백
 * - Unicode11(wide/CJK), FitAddon, WebLinks, Clipboard
 * - devicePixelRatio 변화 처리
 * - PTY 출력은 Channel(raw 바이트) → write(콜백)에서 ACK 플로우 컨트롤
 */
export async function createTerminal(
  container: HTMLElement,
  options: CreateTerminalOptions = {},
): Promise<TerminalHandle> {
  // 폰트 선로드 — open() 전에 보장하지 않으면 셀 정렬이 깨진다.
  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* 폰트 API 미지원 시 무시 */
    }
  }

  const term = new Terminal({
    allowProposedApi: true,
    fontFamily:
      '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: "block",
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    theme: darkTheme,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(new ClipboardAddon());

  term.open(container);

  // WebGL 렌더러 + 컨텍스트 손실 폴백(canvas/DOM 으로).
  let webgl: WebglAddon | undefined;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = undefined;
    });
    term.loadAddon(webgl);
  } catch (e) {
    console.warn("WebGL renderer unavailable, falling back to DOM:", e);
    webgl?.dispose();
    webgl = undefined;
  }

  fitAddon.fit();

  let termId = 0;
  let ackPending = 0;

  // IME 진단 로깅. 릴리즈 빌드(import.meta.env.DEV=false)에서는 undefined 로 제거된다.
  const imeDebug: ((m: string) => void) | undefined = import.meta.env.DEV
    ? (m: string) => {
        invoke("ime_debug", { message: m }).catch(() => {});
      }
    : undefined;

  const writeToPty = (data: string) => {
    imeDebug?.(`PTY <- ${JSON.stringify(data)}`);
    if (termId !== 0) {
      invoke("write_terminal", { id: termId, data }).catch(() => {});
    }
  };

  // WKWebView(Tauri/Safari) 한글·CJK IME 보정.
  // WebKit은 marked-text 상태에 따라 IME 입력을 비표준 경로(insertReplacementText,
  // compositionend 없음)로 흘려보내 xterm이 부분 자모를 떨어뜨린다. 이 애드온이
  // 비표준 경로를 가로채 조합 미리보기를 그리고, 완성 글자만 PTY로 보낸다.
  const ime = new WebkitImeAddon({ onData: writeToPty, onDebug: imeDebug });
  term.loadAddon(ime as unknown as Parameters<Terminal["loadAddon"]>[0]);

  const onOutput = new Channel<ArrayBuffer>();
  onOutput.onmessage = (message) => {
    const bytes = new Uint8Array(message);
    term.write(bytes, () => {
      // 콜백 = 파서가 데이터를 처리 완료한 시점. 누적 후 5k 마다 ack.
      ackPending += bytes.length;
      if (ackPending >= FLOW_ACK_SIZE && termId !== 0) {
        invoke("ack_terminal", { id: termId, bytes: ackPending }).catch(() => {});
        ackPending = 0;
      }
    });
  };

  termId = await invoke<number>("spawn_terminal", {
    cols: term.cols,
    rows: term.rows,
    cwd: options.cwd ?? null,
    shell: options.shell ?? null,
    onOutput,
  });

  // 입력: xterm → PTY. IME 조합 중 누출되는 부분 자모는 shouldSkip 으로 거른다.
  const dataSub = term.onData((data) => {
    const skip = ime.shouldSkip(data);
    imeDebug?.(`TERM.onData ${JSON.stringify(data)} skip=${skip}`);
    if (!skip) {
      // 조합 중 외부 입력(구두점/ASCII 등)이 들어오면 pending 음절을 먼저 PTY로
      // 보내 순서를 보장한다(자+. → 자. , 하+? → 하?).
      ime.flushPending();
      writeToPty(data);
    }
  });

  // 리사이즈: fit 후 PTY cols/rows 동기화
  const doResize = () => {
    try {
      fitAddon.fit();
    } catch {
      /* 컨테이너가 0 크기일 때 등 무시 */
    }
    if (termId !== 0) {
      invoke("resize_terminal", {
        id: termId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
  };

  const resizeObserver = new ResizeObserver(() => doResize());
  resizeObserver.observe(container);

  // devicePixelRatio 변화(모니터 간 이동 등) → 렌더러 갱신 + 재fit.
  let dprCleanup: (() => void) | undefined;
  const armDprListener = () => {
    const mq = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    const handler = () => {
      term.refresh(0, term.rows - 1);
      doResize();
      dprCleanup?.();
      armDprListener();
    };
    mq.addEventListener("change", handler, { once: true });
    dprCleanup = () => mq.removeEventListener("change", handler);
  };
  armDprListener();

  const dispose = () => {
    resizeObserver.disconnect();
    dprCleanup?.();
    dataSub.dispose();
    if (termId !== 0) {
      invoke("close_terminal", { id: termId }).catch(() => {});
    }
    webgl?.dispose();
    term.dispose();
  };

  return {
    terminal: term,
    id: () => termId,
    fit: doResize,
    focus: () => term.focus(),
    dispose,
  };
}
