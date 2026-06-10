import { Terminal, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";

import { WebkitImeAddon } from "../vendor/xterm-addon-webkit-ime";
import { setupShellIntegration } from "./shellIntegration";
import { darkTheme } from "./theme";
import type { TerminalSettings } from "../state/settings";

// editor FlowControlConstants.CharCountAckSize 와 동일.
const FLOW_ACK_SIZE = 5000;

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  theme?: ITheme;
  /** 폰트/커서/스크롤백 등 사용자 설정. 미지정 시 기본값. */
  settings?: TerminalSettings;
}

export interface TerminalHandle {
  terminal: Terminal;
  /** 백엔드 PTY 세션 id (스폰 완료 후 채워짐). */
  readonly id: () => number;
  /** 컨테이너 크기에 맞춰 fit 후 PTY 에 크기 전파. */
  fit: () => void;
  focus: () => void;
  /** 현재 작업 디렉토리(셸 통합 OSC 7/633;P). 미확인 시 undefined. */
  getCwd: () => string | undefined;
  /** cwd 변경 구독(이벤트 기반). 반환=해지. */
  onCwdChange: (cb: (cwd: string) => void) => () => void;
  /** 명령 종료 구독(git 상태 등 갱신 트리거). 반환=해지. */
  onCommandFinished: (cb: () => void) => () => void;
  /** 라이트/다크 등 테마 교체(그리드 fg/ANSI 색). 배경은 CSS --bg 가 담당. */
  setTheme: (theme: ITheme) => void;
  /** 텍스트를 PTY 로 붙여넣기(bracketed paste 모드면 자동 래핑). 파일 드래그 경로 주입용. */
  paste: (text: string) => void;
  /** 폰트/커서/스크롤백 설정을 라이브 적용(폰트 크기 변경 시 재fit). */
  applySettings: (settings: TerminalSettings) => void;
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

  const s = options.settings;
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily:
      s?.fontFamily ??
      '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
    fontSize: s?.fontSize ?? 13,
    lineHeight: 1.0,
    letterSpacing: 0,
    scrollback: s?.scrollback ?? 10000,
    cursorBlink: s?.cursorBlink ?? true,
    cursorStyle: s?.cursorStyle ?? "block",
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    theme: options.theme ?? darkTheme,
  });

  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  // 링크 클릭은 웹뷰 안에서 열지 말고 OS 기본 브라우저로 연다(opener 플러그인).
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      openUrl(uri).catch(() => {});
    }),
  );
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

  // 직접 fit: 컨테이너 전체 크기로 행/열 계산. FitAddon 은 스크롤바용 14px 를 가용
  // 너비에서 빼서 우측에 갭을 만들지만(설치된 0.11.0 기준 overviewRuler?.width || 14),
  // 여기선 container.clientWidth/Height 를 그대로 floor 해 잔여를 1셀 미만으로 최소화한다.
  // 스크롤백 히스토리는 그대로 유지된다. 셀 치수는 렌더 서비스에서 읽는다.
  const fitTerminal = () => {
    // 숨겨진 탭(display:none)은 0 크기 → fit 하면 2열로 줄어드니 건너뛴다.
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }
    const core = (term as unknown as { _core?: any })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width || !cell?.height) {
      return;
    }
    const cols = Math.max(2, Math.floor(container.clientWidth / cell.width));
    const rows = Math.max(1, Math.floor(container.clientHeight / cell.height));
    if (cols !== term.cols || rows !== term.rows) {
      // FitAddon 과 동일하게 리사이즈 전 렌더 캐시를 비운다(잔상/글리프 캐시 방지).
      core._renderService?.clear?.();
      term.resize(cols, rows);
    }
  };

  fitTerminal();
  // 레이아웃이 완전히 적용된 뒤 한 번 더(초기 측정 오차 보정).
  requestAnimationFrame(() => {
    try {
      fitTerminal();
    } catch {
      /* 컨테이너가 아직 0 크기일 때 등 무시 */
    }
  });

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

  // OSC 11 (배경색 질의 응답): 앱이 `ESC ] 11 ; ?` 로 물으면 현재 테마 배경색을
  // XParseColor 형식(rgb:RRRR/GGGG/BBBB)으로 응답한다. Claude Code 등 'auto' 테마
  // 앱이 우리 라이트/다크 모드를 감지/추종한다(systemThemeWatcher 가 폴링). 토글 시
  // term.options.theme.background 가 바뀌므로 응답도 따라 바뀐다.
  term.parser.registerOscHandler(11, (data) => {
    if (data !== "?") {
      return false; // 색 설정 등은 xterm 기본 처리에 위임
    }
    const bg = (term.options.theme?.background as string | undefined) ?? "#1e1e1e";
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
    if (m) {
      const c = (h: string) => `${h}${h}`; // 8bit → 16bit (예: 1e → 1e1e)
      writeToPty(`\x1b]11;rgb:${c(m[1])}/${c(m[2])}/${c(m[3])}\x1b\\`);
    }
    return true;
  });

  // 셸 통합(OSC 133/633/7): 명령 데코레이션 + cwd 추적.
  const shellIntegration = setupShellIntegration(term);

  // WKWebView(Tauri/Safari) 한글·CJK IME 보정.
  // WebKit은 marked-text 상태에 따라 IME 입력을 비표준 경로(insertReplacementText,
  // compositionend 없음)로 흘려보내 xterm이 부분 자모를 떨어뜨린다. 이 애드온이
  // 비표준 경로를 가로채 조합 미리보기를 그리고, 완성 글자만 PTY로 보낸다.
  const ime = new WebkitImeAddon({ onData: writeToPty, onDebug: imeDebug });
  term.loadAddon(ime as unknown as Parameters<Terminal["loadAddon"]>[0]);

  // 이미지 붙여넣기(⌘V): 클립보드에 이미지만 있고 텍스트가 없으면, TUI 앱(Claude Code
  // 등)이 OS 클립보드를 직접 읽도록 "빈 bracketed paste"(ESC[200~ ESC[201~)만 보낸다.
  // Claude Code 는 macOS 에서 빈 paste 를 신호로 osascript 로 클립보드 이미지를 읽는다.
  // bracketed paste 모드가 꺼진 셸 프롬프트에서는 보낼 게 없으므로 xterm 기본(무동작)에 맡긴다.
  const onPaste = (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const items = Array.from(dt.items ?? []);
    const files = Array.from(dt.files ?? []);
    const hasImage =
      items.some((it) => it.kind === "file" && it.type.startsWith("image/")) ||
      files.some((f) => f.type.startsWith("image/"));
    const text = dt.getData("text/plain");
    if (hasImage && !text && term.modes.bracketedPasteMode) {
      e.preventDefault();
      e.stopPropagation();
      writeToPty("\x1b[200~\x1b[201~");
    }
  };
  container.addEventListener("paste", onPaste, true);

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
      fitTerminal();
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
    container.removeEventListener("paste", onPaste, true);
    resizeObserver.disconnect();
    dprCleanup?.();
    dataSub.dispose();
    shellIntegration.dispose();
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
    getCwd: () => shellIntegration.getCwd(),
    onCwdChange: (cb) => shellIntegration.onCwdChange(cb),
    onCommandFinished: (cb) => shellIntegration.onCommandFinished(cb),
    setTheme: (theme: ITheme) => {
      term.options.theme = theme;
      // 테마 변경 시 텍스처 아틀라스를 비워 글리프 캐시(색 포함)를 완전 갱신한다.
      webgl?.clearTextureAtlas();
    },
    paste: (text: string) => term.paste(text),
    applySettings: (next: TerminalSettings) => {
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.cursorBlink = next.cursorBlink;
      term.options.cursorStyle = next.cursorStyle;
      term.options.scrollback = next.scrollback;
      webgl?.clearTextureAtlas();
      doResize(); // 폰트 크기 변경 → 셀 치수 변화 → 재fit + PTY resize
    },
    dispose,
  };
}
