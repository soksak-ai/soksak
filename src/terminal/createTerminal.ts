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
import { onLiveResizeEnd } from "./liveResize";
import { darkTheme } from "./theme";
import type { TerminalSettings, XtermRenderer } from "../state/settings";

// editor FlowControlConstants.CharCountAckSize 와 동일.
const FLOW_ACK_SIZE = 5000;

// IME 진단 트레이스(DEV 전용). [원칙] 진단 로깅은 측정 대상을 교란하면 안 된다 —
// 매 이벤트마다 invoke(Tauri IPC)를 때리면 WKWebView 조합(marked-text)이 깨진다
// (claude 등 고빈도 TUI 에서 특히). 그래서 메모리에만 즉시 push 하고, 입력이 멎은
// 뒤에만(트레일링 디바운스) 한 번 /tmp/soksak-ime.log 로 flush 한다 — 조합 중 invoke 0.
const _imeLog: string[] = [];
let _imeFlush: number | undefined;
function imeTrace(m: string): void {
  _imeLog.push(m);
  if (_imeLog.length > 4000) _imeLog.splice(0, _imeLog.length - 4000);
  if (_imeFlush !== undefined) clearTimeout(_imeFlush);
  _imeFlush = window.setTimeout(() => {
    _imeFlush = undefined;
    void invoke("write_text_file", {
      path: "/tmp/soksak-ime.log",
      content: _imeLog.join("\n") + "\n",
    }).catch(() => {});
  }, 400);
}

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  theme?: ITheme;
  /** 폰트/커서/스크롤백 등 사용자 설정. 미지정 시 기본값. */
  settings?: TerminalSettings;
  /** spawn 직후 PTY 로 자동 실행할 명령(예: claude/codex). 첫 pane 에서만. */
  initialCommand?: string;
  /** 이 터미널의 pane id — 셸에 SOKSAK_PANE 으로 주입(sok CLI 컨텍스트 타기팅). */
  paneId?: string;
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
  /** 명령 시작 구독(명령라인 동반 — "어떤 명령이 떴나"). 반환=해지. */
  onCommandStart: (cb: (commandLine: string) => void) => () => void;
  /** 명령 종료 구독(git 상태 등 갱신 트리거). 반환=해지. */
  onCommandFinished: (cb: () => void) => () => void;
  /** 라이트/다크 등 테마 교체(그리드 fg/ANSI 색). 배경은 CSS --bg 가 담당. */
  setTheme: (theme: ITheme) => void;
  /** 텍스트를 PTY 로 붙여넣기(bracketed paste 모드면 자동 래핑). 파일 드래그 경로 주입용. */
  paste: (text: string) => void;
  /** raw 바이트를 PTY 에 그대로 쓴다(키 주입 — TUI 조작용: \r, \x1b[A, ^C 등). */
  sendInput: (data: string) => void;
  /** 화면+스크롤백 텍스트 직렬화(끝에서 lines 줄, 기본 전체 뷰포트+스크롤백). AI 의 눈. */
  readBuffer: (lines?: number) => string;
  /** PTY 출력으로 화면이 갱신될 때 구독(프레임당 1회 코얼레스 — 쓰기 폭주 과통지 방지).
   *  반환=해지. 플러그인이 라이브 버퍼(스트림 표시)·입력 landed 검증에 쓰는 범용 신호. */
  onOutput: (cb: () => void) => () => void;
  /** 폰트/커서/스크롤백 설정을 라이브 적용(폰트 크기 변경 시 재fit). */
  applySettings: (settings: TerminalSettings) => void;
  dispose: () => void;
}

/**
 * editor xtermTerminal.ts 패턴을 따른 터미널 생성:
 * - 폰트 로드 완료 후 open (셀 메트릭 정확)
 * - 렌더러: 설정 xtermRenderer 로 WebGL(기본) ↔ DOM — 아래 [렌더러 선택] 참조
 * - Unicode11(wide/CJK), WebLinks, Clipboard
 * - devicePixelRatio 변화 처리
 * - PTY 출력은 Channel(raw 바이트) → write(콜백)에서 ACK 플로우 컨트롤
 *
 * [렌더러 선택 — WKWebView 합성 stretch 불변식] @MX:ANCHOR
 * macOS 라이브 리사이즈(inLiveResize) 동안 AppKit 은 redraw 를 멈추고 GPU 합성
 * 레이어(WebGL 의 <canvas>)를 새 창 크기로 CALayer 스케일한다 → 글자가 늘어난다
 * (합성 stretch). DOM 은 WebKit 이 매 프레임 타일 재래스터하므로 또렷하다. Chromium
 * 은 리사이즈 콜백에서 동기 페인트로 회피하지만 WKWebView 엔 그 경로가 없어 Safari
 * 에도 같은 증상이 있다(구조적 한계). 기본 렌더러는 WebGL(처리량 우선) — 단 리사이즈
 * 중 늘어남이 따라온다. 리사이즈 정확성이 필요하면 DOM 으로 전환한다(WebKit 이 DOM 을
 * 재래스터해 안 늘어남): 설정 xtermRenderer=dom(또는 sok settings.set key=xtermRenderer).
 * 처리량과 정확성의 트레이드오프. 비교·근거: docs/PERFORMANCE.md.
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

  // 렌더러: 설정(xtermRenderer)으로 WebGL(기본) ↔ DOM. 위 [렌더러 선택] 불변식 참조.
  // 애드온 미적재 = 내장 DOM 렌더러. WebGL addon 은 dispose 시 DOM 으로 복귀하므로
  // 런타임 전환(applySettings)이 안전하다 — 컨텍스트 손실 폴백과 동일 경로.
  let webgl: WebglAddon | undefined;
  const setRenderer = (mode: XtermRenderer) => {
    if (mode === "webgl") {
      if (webgl) return; // 이미 WebGL
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = undefined; // 컨텍스트 손실 → DOM 폴백
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch (e) {
        console.warn("WebGL 렌더러 사용 불가 — DOM 유지:", e);
        webgl = undefined;
      }
    } else if (webgl) {
      webgl.dispose(); // → xterm 내장 DOM 렌더러로 복귀
      webgl = undefined;
    }
  };
  setRenderer(s?.xtermRenderer ?? "dom");

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
      // _renderService.clear() 는 호출하지 않는다 — 현재 xterm.js FitAddon 에는
      // 없는 옛 번들의 유물이고, 캔버스를 통째로 비워 WebKit 이 페인트를 멈춘
      // inLiveResize 중에 빈(깜빡) 프레임을 만든다. resize() 가 재렌더를 책임진다.
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
    ? imeTrace
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

  // PTY 출력으로 화면이 바뀔 때 통지(코어 범용 소켓 — 플러그인 라이브 스트림/입력 검증용).
  // rAF 로 프레임당 1회 코얼레스: TUI 가 한 프레임에 수십 청크를 써도 통지는 한 번.
  const outputSubs = new Set<() => void>();
  let outputNotifyScheduled = false;
  const notifyOutput = () => {
    if (outputNotifyScheduled || outputSubs.size === 0) return;
    outputNotifyScheduled = true;
    requestAnimationFrame(() => {
      outputNotifyScheduled = false;
      for (const cb of [...outputSubs]) {
        try {
          cb();
        } catch (e) {
          console.error("terminal onOutput 구독자 실패:", e);
        }
      }
    });
  };

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
      notifyOutput(); // 화면 갱신 통지(코얼레스됨).
    });
  };

  termId = await invoke<number>("spawn_terminal", {
    cols: term.cols,
    rows: term.rows,
    cwd: options.cwd ?? null,
    shell: options.shell ?? null,
    paneId: options.paneId ?? null,
    onOutput,
  });

  // 첫 프로그램 자동 실행(claude/codex). 셸 프롬프트가 뜨면 PTY 가 버퍼한 입력을 처리한다.
  if (options.initialCommand) {
    writeToPty(`${options.initialCommand}\r`);
  }

  // 입력: xterm → PTY. IME 조합 중 누출되는 부분 자모는 shouldSkip 으로 거른다.
  const dataSub = term.onData((data) => {
    const skip = ime.shouldSkip(data);
    imeDebug?.(`TERM.onData ${JSON.stringify(data)} skip=${skip}`);
    if (!skip) {
      // 조합 중 외부 입력(구두점/ASCII 등)이 들어오면 pending 음절을 먼저 PTY로
      // 보내 순서를 보장한다(자+. → 자. , 하+? → 하?).
      //
      // [HARD] 단 ESC 시퀀스(CPR/DA/OSC 등)는 flush 대상이 아니다 — claude 같은 TUI 는
      // 커서 위치(DSR `ESC[6n`)를 끊임없이 질의하고, xterm 이 CPR(`ESC[…R`)로 자동 응답
      // 하는데 그 응답이 이 onData 로 흐른다. flushPending 이 그 응답마다 조합 중인 한글을
      // 강제 flush 하면 → 첫 자모만 나간 자모 누수(ㅎ)·음절 중복(flush "한" + 최종 commit
      // "한")이 발생한다. 셸은 커서를 안 물어 안 터지고, claude 만 터지던 근본 원인.
      // 사용자 평문 입력(비 ESC)만 flush 한다(트레이스: /tmp/soksak-pty.log 로 확정).
      if (data.charCodeAt(0) !== 0x1b) ime.flushPending();
      writeToPty(data);
    }
  });

  // 리사이즈 정책(라이브 reflow + blank 없음 + 프롬프트 정합 — PERFORMANCE.md 원칙 4·5):
  // 드래그 중에도 화면이 새 폭에 맞춰 reflow 하되(라이브), fit·PTY 를 함께 "스로틀"한다.
  //  ① 왜 스로틀(매 프레임 아님): 빠른 드래그는 프레임당 cols 가 크게 점프해 매 프레임
  //     reflow(스크롤백 비례)+캔버스 리얼록이 16ms 예산을 넘긴다 → xterm 의 rAF 렌더가
  //     한 번도 완료 못 해 본문이 통째로 비는(blank) 프레임이 지속된다(실측). 느린
  //     드래그는 작은 reflow 라 멀쩡. FIT_THROTTLE_MS 간격이면 그 사이 렌더가 완료돼
  //     빠른 드래그도 라이브로 보이며 blank 가 없다(leading+trailing).
  //  ② 왜 PTY 도 함께(과거엔 150ms 디바운스): 셸은 정적 프롬프트를 SIGWINCH 때만 다시
  //     그린다. PTY 를 끝에만 보내면 드래그 중 셸이 SIGWINCH 를 못 받아, xterm 이 reflow
  //     하며 cursor(프롬프트) 줄을 망가뜨린 채 남는다(시작=끝 폭이면 net SIGWINCH 0 →
  //     영영 안 고쳐짐 — 실측). 네이티브 터미널처럼 드래그 중 SIGWINCH 를 보내면 셸이
  //     매 틱 프롬프트를 새 폭으로 다시 그려 항상 정확하다. 스로틀(50ms=20Hz)이라 TUI
  //     재그리기 부담도 네이티브 수준.
  // _renderService.clear() 는 제거 유지(캔버스를 비워 깜빡임 유발 — 옛 번들 유물).
  // 치수 변화 시 term.refresh(전체 행)로 최종 폭 깨끗이 재렌더(비우지 않아 깜빡임 없음).
  const FIT_THROTTLE_MS = 50; // 렌더 1회가 완료될 여유(reflow+그리기 < 50ms)
  let lastFitAt = 0;
  let fitTimer: number | undefined;
  const syncPty = () => {
    if (termId !== 0) {
      invoke("resize_terminal", {
        id: termId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
  };
  const safeFit = () => {
    try {
      lastFitAt = performance.now();
      const before = `${term.cols}x${term.rows}`;
      fitTerminal();
      if (`${term.cols}x${term.rows}` !== before) {
        term.refresh(0, term.rows - 1);
        syncPty(); // 셸에 SIGWINCH — 정적 프롬프트도 새 폭으로 다시 그린다.
      }
    } catch {
      /* 컨테이너가 0 크기일 때 등 무시 */
    }
  };
  // fit+PTY 스로틀(leading+trailing): 직전 fit 후 THROTTLE 경과면 즉시, 아니면 남은
  // 시간 뒤 1회 — 연속 드래그 중 빈도를 렌더·셸이 따라올 수준으로 제한한다.
  const scheduleFit = () => {
    const since = performance.now() - lastFitAt;
    if (since >= FIT_THROTTLE_MS) {
      if (fitTimer !== undefined) {
        clearTimeout(fitTimer);
        fitTimer = undefined;
      }
      safeFit();
    } else if (fitTimer === undefined) {
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined;
        safeFit();
      }, FIT_THROTTLE_MS - since);
    }
  };
  const doResize = (immediate = false) => {
    if (immediate) {
      if (fitTimer !== undefined) {
        clearTimeout(fitTimer);
        fitTimer = undefined;
      }
      safeFit();
      syncPty();
      return;
    }
    // 숨김 터미널(비활성 탭/뷰 — visibility:hidden 슬롯) 스킵: 창/사이드바
    // 리사이즈 때 안 보이는 터미널까지 fit+IPC 할 이유가 없다. 노출 시
    // PaneLeaf 가 즉시 fit 으로 보정한다(Safari 17.4+ checkVisibility).
    if (
      typeof container.checkVisibility === "function" &&
      !container.checkVisibility({ visibilityProperty: true })
    ) {
      return;
    }
    scheduleFit();
  };

  const resizeObserver = new ResizeObserver(() => doResize());
  resizeObserver.observe(container);
  // 라이브 리사이즈 끝(네이티브 신호) → 마지막 프레임을 한 번 더 즉시 보정.
  const offResizeEnd = onLiveResizeEnd(() => doResize(true));

  // devicePixelRatio 변화(모니터 간 이동 등) → 렌더러 갱신 + 재fit.
  let dprCleanup: (() => void) | undefined;
  const armDprListener = () => {
    const mq = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    const handler = () => {
      term.refresh(0, term.rows - 1);
      doResize(true); // 모니터 이동 = 즉시 보정
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
    offResizeEnd();
    clearTimeout(fitTimer);
    dprCleanup?.();
    dataSub.dispose();
    shellIntegration.dispose();
    outputSubs.clear(); // 잔여 rAF 통지를 no-op 으로 — 폐기 후 stale 구독 호출 방지.
    if (termId !== 0) {
      invoke("close_terminal", { id: termId }).catch(() => {});
    }
    webgl?.dispose();
    term.dispose();
  };

  return {
    terminal: term,
    id: () => termId,
    // 포커스/노출/이동(appendChild) 직후 호출되는 경로 — 지금 맞춰야 한다.
    fit: () => doResize(true),
    focus: () => term.focus(),
    getCwd: () => shellIntegration.getCwd(),
    onCwdChange: (cb) => shellIntegration.onCwdChange(cb),
    onCommandStart: (cb) => shellIntegration.onCommandStart(cb),
    onCommandFinished: (cb) => shellIntegration.onCommandFinished(cb),
    setTheme: (theme: ITheme) => {
      term.options.theme = theme;
      // 테마 변경 시 텍스처 아틀라스를 비워 글리프 캐시(색 포함)를 완전 갱신한다.
      webgl?.clearTextureAtlas();
    },
    paste: (text: string) => term.paste(text),
    sendInput: (data: string) => writeToPty(data),
    readBuffer: (lines?: number) => {
      // 활성 버퍼(일반=스크롤백 포함, TUI alternate=현재 화면)를 줄 텍스트로 직렬화.
      // "끝에서 N줄"은 내용이 있는 마지막 줄 기준 — 커서 아래의 빈 뷰포트 줄은 제외.
      const buf = term.buffer.active;
      const line = (i: number) => buf.getLine(i)?.translateToString(true) ?? "";
      let end = buf.length - 1;
      while (end >= 0 && line(end) === "") end--;
      if (end < 0) return "";
      const want = lines && lines > 0 ? Math.min(lines, end + 1) : end + 1;
      const out: string[] = [];
      for (let i = end + 1 - want; i <= end; i++) out.push(line(i));
      return out.join("\n");
    },
    onOutput: (cb) => {
      outputSubs.add(cb);
      return () => {
        outputSubs.delete(cb);
      };
    },
    applySettings: (next: TerminalSettings) => {
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.cursorBlink = next.cursorBlink;
      term.options.cursorStyle = next.cursorStyle;
      term.options.scrollback = next.scrollback;
      // resizeReflow 설정은 현 리사이즈 정책(네이티브 신호 기반)과 무관 — 보존만.
      setRenderer(next.xtermRenderer); // 렌더러 라이브 전환(DOM ↔ WebGL) — 변화 없으면 no-op
      webgl?.clearTextureAtlas();
      doResize(true); // 폰트 크기 변경 → 셀 치수 변화 → 즉시 재fit + PTY resize
      term.refresh(0, term.rows - 1); // 렌더러 전환·설정 변경 후 전체 재페인트
    },
    dispose,
  };
}
