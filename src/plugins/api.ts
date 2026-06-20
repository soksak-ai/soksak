// 플러그인 API — activate(ctx) 로 전달되는 호스트 표면(soksak-plugin-spec v1 §0).
// 원칙:
//   - 권한은 API 표면 게이트(§0-2): 미선언 권한의 표면은 undefined.
//   - 명령은 registry 단일진실(§0-1): 등록 즉시 sok/MCP 에 자동 노출.
//   - 매니페스트가 선언의 단일진실: 선언 안 된 명령/뷰/포매터의 바인딩은 거부.
//   - 모든 등록은 내부 tracker 가 자동 수거 — 비활성화 시 누수 불가(§0-4).
//   - 의존성은 deps 로 주입(테스트 가능 구조 — 꼼수가 아니라 구조로 해결).

import type {
  CommandContext,
  CommandOutcome,
  CommandSpec,
  ParamSpec,
} from "../commands/registry";
import { Channel } from "@tauri-apps/api/core";
import { busEmit, busOn } from "./bus";
import {
  onPluginEvent,
  type Disposable,
  type PluginEventMap,
} from "./hooks";
import {
  useViewRegistry,
  type PluginViewProvider,
} from "./viewRegistry";
import {
  useFileViewerRegistry,
  type FileViewerProvider,
} from "./fileViewerRegistry";
import { useEditorRegistry } from "./editorRegistry";
import { useIconRegistry, validateIconSetData } from "../ui/icons/registry";
import {
  registerStatusBarItem,
  type StatusBarItem,
} from "../ui/statusBarItems";
import { registerHeaderAction, type HeaderAction } from "../ui/headerActions";
import { useUi } from "../state/ui";
import { pushNotification, type NotificationInput } from "../lib/notify";
import { playSound, BUILTIN_SOUNDS } from "../ui/sound";
import {
  runningCommands,
  sendInputToHost,
  readHostBuffer,
  subscribeOutput,
} from "../terminal/paneHosts";
import { EVENT_PERMISSIONS } from "./hooks";
import type { IconSetData } from "../ui/icons/types";
import {
  configDefaults,
  pluginCommandName,
  qualifiedViewId,
  type PluginManifest,
  type PluginPermission,
  type ViewPlacement,
} from "./spec";
import { localize } from "../i18n";
import { useSettings } from "../state/settings";
import { usePluginSettings, type SettingValue } from "../state/pluginSettings";
import { useSessions } from "../state/sessions";
import type { Extension } from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as cmState from "@codemirror/state";
import * as cmLanguage from "@codemirror/language";

export type { Disposable } from "./hooks";

// ── 의존성 주입 표면 ─────────────────────────────────────────────────────────

export interface PluginApiDeps {
  appVersion: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  execute: (
    name: string,
    params: Record<string, unknown>,
    ctx: CommandContext,
  ) => Promise<CommandOutcome>;
  registerCommand: (name: string, spec: CommandSpec) => void;
  unregisterCommand: (name: string) => boolean;
  getCommandDanger: (name: string) => "destructive" | "inject" | undefined;
  on: typeof onPluginEvent;
  currentProject: () => { id: string; root: string | null } | null;
  // 활성 파일 뷰(에디터 통합 M_P7 에서 FileViewer 가 bridge 구현을 채운다).
  activeFile: () => { viewId: string; path: string; text: string } | null;
  setFileText: (viewId: string, text: string) => boolean;
  // 코어 fs watcher(fs-change) 구독 — 변경된 부모 디렉토리 문자열을 콜백. 반환=해지.
  onFsChange: (cb: (dir: string) => void) => () => void;
  // 코어 데이터 스토어 변경(data-change) 구독 — Rust 싱글톤이 전 창 브로드캐스트(멀티윈도우·같은
  // 프로젝트 일관). app.data.watch 가 ns/coll/scope 로 필터. 반환=해지. (선례 onFsChange.)
  onDataChange: (cb: (e: DataChangeEvent) => void) => () => void;
  // 클립보드 변경(clipboard-change) 전 창 구독 — 바뀐 텍스트를 콜백. 반환=해지. (선례 onFsChange.)
  // 폴링은 macOS 한정(NSPasteboard 이벤트 없음); Win/X11/Wayland 은 네이티브 이벤트 — 코어가 흡수.
  onClipboardChange: (cb: (text: string) => void) => () => void;
  // 터미널 pane cwd 스냅샷/구독 + 명령 종료 구독(코어 paneHosts 브리지). app.terminal 이 노출.
  getCwd: (paneId: string) => string | undefined;
  subscribeCwd: (paneId: string, cb: (cwd: string) => void) => () => void;
  subscribeCommandFinished: (paneId: string, cb: () => void) => () => void;
}

// data-change 페이로드 — Rust commands.rs DataChange 와 동형. coll/scope/id 는 연산에 따라 null.
export interface DataChangeEvent {
  ns: string;
  coll: string | null;
  scope: string | null;
  op: string;
  id: string | null;
}

// ── 플러그인이 보는 타입 ─────────────────────────────────────────────────────

export interface PluginCommandSpec {
  // description = 영어 base(LLM 발견 표면 — stub 금지). triggers = 비영어 트리거어(언어→단어).
  // 호스트 catalogJson 이 base+triggers 를 합성(docs/I18N.md §3). 사람 UI 는 contributes.commands.title.
  description: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  returns?: string;
  examples?: readonly string[];
  danger?: "destructive" | "inject";
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}

export interface SoksakPluginApi {
  appVersion: string;
  pluginId: string;
  // 호스트 표시 언어(권한 불요 컨텍스트 §3.5) — 변경은 locale.changed 이벤트.
  locale: () => string;
  commands?: {
    execute: (
      name: string,
      params?: Record<string, unknown>,
    ) => Promise<CommandOutcome>;
    register: (name: string, spec: PluginCommandSpec) => Disposable;
  };
  events: {
    on: <K extends keyof PluginEventMap>(
      event: K,
      fn: (payload: PluginEventMap[K]) => void,
    ) => Disposable;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
    /** 확장자별 파일 뷰어 등록(contributes.fileViewers 선언 필수). 코어가 파일을 콘텐츠로 열 때
     *  매칭 뷰어의 provider 를 마운트한다(엔진 중립 A13 — 렌더 엔진은 플러그인 소유). 반환=해지. */
    registerFileViewer: (
      viewerId: string,
      provider: FileViewerProvider,
    ) => Disposable;
    openView: (
      viewId: string,
      placement?: ViewPlacement,
    ) => Promise<CommandOutcome>;
    /** 아이콘 셋 등록(contributes.iconSets 선언 필수). data 는 시맨틱 이름 전수 제공. */
    registerIconSet: (setId: string, data: unknown) => Disposable;
    /** paneId 연관 상태바 아이템 등록/갱신(같은 id 면 교체 — active 토글에 재호출).
     *  그 pane 이 활성 터미널인 그룹의 상태바에 표시된다. 반환 = 해지. */
    statusBarItem: (item: StatusBarItem) => Disposable;
    /** 타이틀바 우측 컨트롤(사이드바·다크모드·설정) 옆에 토글 아이콘 등록(같은 id 면 교체 —
     *  active 토글에 재호출). "ui:titlebar" 권한 필요. 반환 = 해지. */
    registerHeaderAction: (action: HeaderAction) => Disposable;
    /** 모달/오버레이 표시 동안 입력 게이트 활성(콘텐츠 네이티브 webview 영역 위 클릭 성립).
     *  "ui:overlay:*" 권한 필요. 표시 시 true, 숨김/정리 시 false 를 호출(호출자가 균형 관리). */
    setOverlayActive: (active: boolean) => void;
    /** 이 플러그인 뷰의 사이드바 탭 배지(읽지않음 표시). number=카운트, "dot"=점, null=해제.
     *  뷰 안에서는 mount ctx.setBadge 가 편하고, 이건 뷰 밖에서 갱신할 때. per-window. */
    setViewBadge: (viewId: string, badge: number | "dot" | null) => void;
  };
  editor?: {
    // 호스트의 @codemirror 모듈(§0-7 — 플러그인 자체 번들 금지).
    modules: {
      view: typeof cmView;
      state: typeof cmState;
      language: typeof cmLanguage;
    };
    registerExtension: (reg: {
      extension: Extension;
      languages?: string[];
    }) => Disposable;
    // 매니페스트 contributes.formatters 의 선언 id 에 핸들러를 바인딩.
    registerFormatter: (reg: {
      id: string;
      format: (
        text: string,
        ctx: { path: string; ext: string },
      ) => string | Promise<string>;
    }) => Disposable;
    getActiveFile: () => { viewId: string; path: string; text: string } | null;
    setFileText: (viewId: string, text: string) => boolean;
  };
  storage?: {
    read: (key: string) => Promise<unknown>;
    write: (key: string, value: unknown) => Promise<void>;
    list: () => Promise<string[]>;
  };
  /** 범용 임베디드 데이터 스토어(코어 SQLite 싱글톤). DB-agnostic — raw SQL 비노출. 네임스페이스는
   *  이 플러그인 id 로 강제(다른 플러그인 데이터 불가시). scope = 프로젝트 단위 파티션(예: projectId).
   *  watch = 전 창 변경 구독(폴링 0, 멀티윈도우·같은 프로젝트 일관). "data" 권한 한정. */
  data?: {
    kv: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      keys: (prefix?: string) => Promise<string[]>;
    };
    /** 컬렉션 정의(멱등) — indexes=구조 질의 필드, fts=CJK 전문검색 필드. */
    define: (
      collection: string,
      opts: { indexes?: string[]; fts?: string[] },
    ) => Promise<void>;
    /** 레코드 upsert. id 미지정 시 생성·반환. doc 에 canonical id 주입됨. */
    put: (
      collection: string,
      doc: Record<string, unknown>,
      opts?: { scope?: string; id?: string },
    ) => Promise<string>;
    get: (
      collection: string,
      id: string,
      opts?: { scope?: string },
    ) => Promise<unknown>;
    delete: (
      collection: string,
      id: string,
      opts?: { scope?: string },
    ) => Promise<boolean>;
    /** 구조 질의 — where 필드는 define 의 indexes 로 선언돼야 함(또는 created/updated). */
    query: (
      collection: string,
      opts?: {
        scope?: string;
        where?: Record<string, unknown>;
        order?: string;
        desc?: boolean;
        limit?: number;
        offset?: number;
      },
    ) => Promise<unknown[]>;
    /** CJK 전문검색(FTS5 trigram). 쿼리 <3 코드포인트는 LIKE 폴백. */
    search: (
      collection: string,
      text: string,
      opts?: { scope?: string; limit?: number },
    ) => Promise<unknown[]>;
    count: (
      collection: string,
      opts?: { scope?: string; where?: Record<string, unknown> },
    ) => Promise<number>;
    /** 변경 구독 — 이 ns·coll(+scope 지정 시 그 scope)의 put/delete 시 콜백(전 창). 반환=해지. */
    watch: (
      collection: string,
      opts: { scope?: string } | undefined,
      cb: (e: DataChangeEvent) => void,
    ) => Disposable;
  };
  /** 암호화 시크릿 볼트(코어 — OS 키체인 비의존 순수 Rust crypto). API 키·토큰 같은 민감값을 봉인 저장.
   *  네임스페이스는 이 플러그인 id 로 강제(app.data 와 동일 격리). get 없음 — 평문 readback 차단(주입
   *  전용). 볼트가 잠겨 있으면 호출은 reject("vault locked"). "secrets" 권한 한정. */
  secrets?: {
    /** 값 봉인 저장(envelope: 항목별 DEK 를 KEK 로 wrap). 같은 key 면 교체. */
    set: (key: string, value: string) => Promise<void>;
    /** key 존재 여부(값은 노출 안 함). */
    has: (key: string) => Promise<boolean>;
    /** key 삭제(있었으면 true). */
    delete: (key: string) => Promise<boolean>;
    /** 이 ns 의 key 목록만(값 아님 — 평문 차단). */
    keys: () => Promise<string[]>;
    /** 볼트 백엔드·잠금 상태({ backend:"vault", unlocked }). */
    backend: () => Promise<{ backend: string; unlocked: boolean }>;
  };
  /** 알림 = 푸시 동급 1급 객체(리치 페이로드). 포커스 시 인앱 배너·비포커스 시 OS 알림(동일 페이로드).
   *  클릭/액션 시 deepLink(soksak://cmd/...) 로 활성화(권한·danger 게이트 유지). "notify" 권한. */
  notify?: {
    push: (n: NotificationInput) => Promise<void>;
  };
  /** 알림 소리(순수 Web Audio). 내장음(default/ping/chime/success/alert) 또는 URL/asset 경로. */
  sound?: {
    play: (sound: string) => Promise<void>;
    builtins: () => string[];
  };
  fs?: {
    /** 텍스트 읽기. offset(바이트) 지정 시 그 지점부터 끝까지만 — 증가 로그의 증분 tail.
     *  totalBytes 를 다음 offset 으로 추적하면 델타만 읽는다. truncated = 안전상한 초과. */
    readText?: (
      path: string,
      offset?: number,
    ) => Promise<{ text: string; truncated: boolean; totalBytes: number }>;
    /** 바이너리 읽기 → { mime, base64 }(data URL 구성용). 미디어 뷰어(이미지/PDF/영상/오디오)가
     *  플러그인에서 파일을 렌더할 때 쓴다. "fs:read" 권한. */
    readBinary?: (path: string) => Promise<{ mime: string; base64: string }>;
    writeText?: (path: string, content: string) => Promise<void>;
    /** 디렉토리 직속 자식. meta:true 면 각 자식 modified(unix 초) 포함(최신 파일 선택용). */
    list?: (path: string, opts?: { meta?: boolean }) => Promise<unknown>;
    /** 디렉토리 감시(코어 watcher, 폴링 없음). dir 안의 변경 시 cb(dir). 비재귀 —
     *  하위 폴더는 따로 watch. 반환 = 해지(unwatch). */
    watch?: (dir: string, cb: (dir: string) => void) => Disposable;
  };
  /** 시스템 클립보드 — read/write 권한별 메서드 게이트. watch = 전 창 변경 구독(폴링 macOS 한정,
   *  코어가 OS별 흡수). 변경 시 바뀐 텍스트를 콜백(구독 자체가 "clipboard:read" 동의 대상). */
  clipboard?: {
    readText?: () => Promise<string>;
    writeText?: (text: string) => Promise<void>;
    watch?: (cb: (e: { text: string }) => void) => Disposable;
  };
  git?: {
    log: (opts?: {
      path?: string;
      limit?: number;
      skip?: number;
    }) => Promise<unknown>;
    show: (commit: string, path?: string) => Promise<unknown>;
    diff: (opts?: {
      path?: string;
      file?: string;
      commit?: string;
      staged?: boolean;
    }) => Promise<string>;
    status: (path?: string) => Promise<unknown>;
  };
  terminal?: {
    /** 지금 실행 중인 명령 스냅샷(pane 당 최대 1). command.started/finished 이벤트의
     *  현재-상태 버전 — 실행 중에 늦게 활성화된 플러그인이 즉시 동기화하는 용도(폴링 아님).
     *  "terminal" 권한 한정. */
    runningCommands?: () => {
      paneId: string;
      commandLine: string;
      cwd: string | null;
    }[];
    /** pane 의 터미널 PTY 에 raw 입력 주입(실행 중 프로그램에 타이핑 — 예: claude 프롬프트).
     *  엔터는 "\r". 준비 전이면 false. "terminal:write" 권한 한정. */
    sendText?: (paneId: string, text: string) => boolean;
    /** pane 터미널 화면 텍스트(끝에서 lines 줄, 기본 전체 뷰포트+스크롤백). 준비 전이면
     *  undefined. "terminal:read" 권한 한정. TUI 라이브 스트림 표시·입력 landed 검증용. */
    readBuffer?: (paneId: string, lines?: number) => string | undefined;
    /** pane 터미널 화면 갱신 구독(프레임당 1회 코얼레스, 폴링 없음). 반환=해지.
     *  "terminal:read" 권한 한정 — 버퍼 재독 트리거(라이브 스트림·입력 검증). */
    onOutput?: (paneId: string, cb: () => void) => Disposable;
    /** 이 pane 터미널의 현재 작업 디렉토리(cwd) 스냅샷. 셸 통합(OSC 7/633) 전이면 undefined.
     *  "terminal" 권한. cwd 추종 뷰(파일 탐색기 등)가 ctx.paneId 와 함께 사용. */
    getCwd?: (paneId: string) => string | undefined;
    /** pane cwd 변경 구독(폴링 없음). 현재값이 있으면 등록 즉시 1회. 반환=해지. "terminal" 권한. */
    onCwd?: (paneId: string, cb: (cwd: string) => void) => Disposable;
    /** pane 의 명령 종료(OSC 133/633 D) 구독 — git 등 파생 상태 갱신 트리거. 반환=해지. "terminal" 권한. */
    onCommandFinished?: (paneId: string, cb: () => void) => Disposable;
  };
  /** 외부 서브프로세스 spawn + 양방향 raw stdio(범용 — LSP/MCP/ACP/임의 CLI 통합). "process" 권한.
   *  PTY 가 아니라 순수 파이프 → JSON-RPC 프레이밍 무손상. 이벤트 기반(폴링 0). */
  process?: {
    /** 프로그램 spawn → handle(id). cwd/env 선택. envRemove=부모 env 에서 뗄 키(중첩 가드 제거 등).
     *  secretEnv=envVar→secretKey(이 플러그인 ns 의 시크릿). 평문은 JS 가 안 만진다 — 키 이름만 넘기면
     *  Rust 경계가 볼트에서 해소해 자식 env 에 주입(셸 args·ps·history 무노출 R2). 잠김/미존재면 spawn 실패. */
    spawn: (
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
      },
    ) => Promise<number>;
    /** stdin 에 쓰기(JSON-RPC 프레임 등). */
    write: (handle: number, data: string) => Promise<void>;
    /** stdout 바이트 구독(반환=해지). 리스너 등록 전 도착분은 버퍼되어 유실 0. */
    onData: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** stderr 바이트 구독(반환=해지). */
    onStderr: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** 종료 코드 구독(반환=해지). 종료가 구독보다 먼저면 즉시 1회 호출. */
    onExit: (handle: number, cb: (code: number) => void) => Disposable;
    /** kill + 정리. */
    kill: (handle: number) => Promise<void>;
  };
  /** WebSocket 클라이언트(ws:// 평문). "network" 권한. 브라우저 WebSocket 과 달리 Origin 헤더를
   *  보내지 않아 Origin 을 검사하는 서버(webOS TV SSAP 등)에 연결된다. 이벤트 기반(폴링 0). */
  ws?: {
    /** ws:// URL 연결 → handle(id). 연결 수립 후 resolve. */
    connect: (url: string) => Promise<number>;
    /** 텍스트 프레임 전송. */
    send: (handle: number, text: string) => Promise<void>;
    /** 수신 텍스트 구독(반환=해지). 등록 전 도착분은 버퍼되어 유실 0. */
    onMessage: (handle: number, cb: (text: string) => void) => Disposable;
    /** 닫힘 구독(반환=해지). 이미 닫혔으면 즉시 1회. */
    onClose: (handle: number, cb: () => void) => Disposable;
    /** 연결 종료 + 정리. */
    close: (handle: number) => Promise<void>;
  };
  /** HTTP 요청(범용 — runbook api 실행타입 등). "network" 권한. webview fetch 가 못 하는 임의 출처 +
   *  시크릿 헤더/바디 주입을 코어가 대행. secretSubst=placeholder→secretKey(이 플러그인 ns). 평문은 JS 가
   *  안 만진다 — Rust 경계가 볼트에서 해소해 url/headers/body 의 placeholder 에 치환(history/응답 무노출 R2). */
  network?: {
    http: (req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      secretSubst?: Record<string, string>;
    }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  };
  /** 플러그인 커스텀 이벤트 버스 — 임의 토픽 pub/sub(플러그인 간 스트리밍 coordination). 코어-정의
   *  이벤트(events.on)와 별개. 예: acp-core 가 session/update 를 emit → 코크핏/라운지가 구독. 시스템
   *  접근 0 → 권한 불요(모든 플러그인). */
  bus: {
    emit: (topic: string, payload: unknown) => void;
    on: (topic: string, fn: (payload: any) => void) => Disposable;
  };
  project: {
    current: () => { id: string; root: string | null } | null;
  };
  // 이 플러그인의 사용자 설정(매니페스트 configuration 선언). effective = 프로젝트 오버라이드 ?? 글로벌
  // ?? 스키마 기본. 읽기+구독만(설정 변경은 사용자가 설정 화면/command 로 — 플러그인은 반응만).
  settings: {
    get: (key: string) => SettingValue | undefined;
    all: () => Record<string, SettingValue>;
    onChange: (cb: (all: Record<string, SettingValue>) => void) => Disposable;
  };
}

export interface PluginContext {
  app: SoksakPluginApi;
  manifest: PluginManifest;
  dir: string;
  // 플러그인이 직접 만든 Disposable 을 넣으면 비활성화 시 자동 dispose.
  subscriptions: Disposable[];
}

// ── Disposable 수거 ──────────────────────────────────────────────────────────

export class DisposableTracker {
  private items: Disposable[] = [];

  add(d: Disposable): Disposable {
    this.items.push(d);
    return d;
  }

  wrap(dispose: () => void): Disposable {
    return this.add({ dispose });
  }

  // 역순 해제 — 개별 실패는 격리(§0-4).
  disposeAll(): void {
    const items = this.items.splice(0).reverse();
    for (const d of items) {
      try {
        d.dispose();
      } catch (e) {
        console.error("플러그인 리소스 해제 실패:", e);
      }
    }
  }
}

// ── 관리 명령 차단(§0-5 자기증식 금지) ───────────────────────────────────────
// plugin.view.* 는 뷰 열기/닫기(관리 아님)라 허용. plugin.<id>.* (플러그인 명령)도 허용.

const BLOCKED_MANAGEMENT = new Set([
  "plugin.list",
  "plugin.install",
  "plugin.update",
  "plugin.remove",
  "plugin.enable",
  "plugin.disable",
  "plugin.reload",
]);

export function isBlockedForPlugins(name: string): boolean {
  return BLOCKED_MANAGEMENT.has(name) || name.startsWith("plugin.dev.");
}

// ── API 조립 ─────────────────────────────────────────────────────────────────

const denied = (message: string): CommandOutcome => ({
  ok: false,
  code: "PERMISSION_DENIED",
  message,
});

// app.process 구현 — handle(id)별 리스너 + 등록 전 도착분 버퍼(유실 0). spawn 시 Channel 3개
// (stdout/stderr/exit)를 만들어 process_spawn 에 넘기고, onData/onStderr/onExit 가 그 스트림을 구독.
function createProcessApi(deps: PluginApiDeps, tracker: DisposableTracker, ns: string) {
  type Bytes = (d: Uint8Array) => void;
  interface ProcState {
    stdout: Set<Bytes>;
    stderr: Set<Bytes>;
    exit: Set<(code: number) => void>;
    stdoutBuf: Uint8Array[];
    stderrBuf: Uint8Array[];
    exitCode: number | null;
  }
  const procs = new Map<number, ProcState>();
  const dispatch = (set: Set<Bytes>, buf: Uint8Array[], b: Uint8Array) => {
    if (set.size) set.forEach((f) => f(b));
    else buf.push(b);
  };
  const subscribe = (set: Set<Bytes>, buf: Uint8Array[], cb: Bytes): Disposable => {
    set.add(cb);
    for (const b of buf.splice(0)) cb(b); // 등록 전 버퍼 즉시 재생(유실 0)
    return tracker.wrap(() => set.delete(cb));
  };
  return {
    async spawn(
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
      },
    ): Promise<number> {
      const st: ProcState = {
        stdout: new Set(),
        stderr: new Set(),
        exit: new Set(),
        stdoutBuf: [],
        stderrBuf: [],
        exitCode: null,
      };
      const onStdout = new Channel<ArrayBuffer>();
      onStdout.onmessage = (m) => dispatch(st.stdout, st.stdoutBuf, new Uint8Array(m));
      const onStderr = new Channel<ArrayBuffer>();
      onStderr.onmessage = (m) => dispatch(st.stderr, st.stderrBuf, new Uint8Array(m));
      const onExit = new Channel<number>();
      onExit.onmessage = (code) => {
        if (st.exit.size) st.exit.forEach((f) => f(code));
        else st.exitCode = code;
      };
      // 평문은 JS 가 만지지 않는다 — 키 이름만 넘긴다(secretEnv: envVar→secretKey). ns=플러그인 id.
      // 평문 해소·자식 env 주입은 Rust 경계(process_spawn)에서만(R2). secretEnv 없으면 null.
      const id = (await deps.invoke("process_spawn", {
        cmd,
        args,
        cwd: opts?.cwd ?? null,
        env: opts?.env ?? null,
        envRemove: opts?.envRemove ?? null,
        ns,
        secretEnv: opts?.secretEnv ?? null,
        onStdout,
        onStderr,
        onExit,
      })) as number;
      procs.set(id, st);
      return id;
    },
    write: async (handle: number, data: string): Promise<void> => {
      await deps.invoke("process_write", { id: handle, data });
    },
    onData(handle: number, cb: Bytes): Disposable {
      const st = procs.get(handle);
      return st ? subscribe(st.stdout, st.stdoutBuf, cb) : tracker.wrap(() => {});
    },
    onStderr(handle: number, cb: Bytes): Disposable {
      const st = procs.get(handle);
      return st ? subscribe(st.stderr, st.stderrBuf, cb) : tracker.wrap(() => {});
    },
    onExit(handle: number, cb: (code: number) => void): Disposable {
      const st = procs.get(handle);
      if (!st) return tracker.wrap(() => {});
      if (st.exitCode !== null) {
        cb(st.exitCode); // 종료가 구독보다 먼저면 즉시 1회
        return tracker.wrap(() => {});
      }
      st.exit.add(cb);
      return tracker.wrap(() => st.exit.delete(cb));
    },
    kill: async (handle: number): Promise<void> => {
      await deps.invoke("process_kill", { id: handle });
      procs.delete(handle);
    },
  };
}

// app.ws 구현 — handle 별 message/close 리스너 + 등록 전 도착분 버퍼(유실 0). createProcessApi 와 동형.
function createWsApi(deps: PluginApiDeps, tracker: DisposableTracker) {
  type Txt = (t: string) => void;
  interface WsState {
    msg: Set<Txt>;
    close: Set<() => void>;
    msgBuf: string[];
    closed: boolean;
  }
  const conns = new Map<number, WsState>();
  return {
    async connect(url: string): Promise<number> {
      const st: WsState = { msg: new Set(), close: new Set(), msgBuf: [], closed: false };
      const onMessage = new Channel<string>();
      onMessage.onmessage = (t) => {
        if (st.msg.size) st.msg.forEach((f) => f(t));
        else st.msgBuf.push(t);
      };
      const onClose = new Channel<null>();
      onClose.onmessage = () => {
        st.closed = true;
        st.close.forEach((f) => f());
      };
      const id = (await deps.invoke("ws_connect", { url, onMessage, onClose })) as number;
      conns.set(id, st);
      return id;
    },
    send: async (handle: number, text: string): Promise<void> => {
      await deps.invoke("ws_send", { id: handle, text });
    },
    onMessage(handle: number, cb: Txt): Disposable {
      const st = conns.get(handle);
      if (!st) return tracker.wrap(() => {});
      st.msg.add(cb);
      for (const t of st.msgBuf.splice(0)) cb(t); // 등록 전 버퍼 재생(유실 0)
      return tracker.wrap(() => st.msg.delete(cb));
    },
    onClose(handle: number, cb: () => void): Disposable {
      const st = conns.get(handle);
      if (!st) return tracker.wrap(() => {});
      if (st.closed) {
        cb();
        return tracker.wrap(() => {});
      }
      st.close.add(cb);
      return tracker.wrap(() => st.close.delete(cb));
    },
    close: async (handle: number): Promise<void> => {
      await deps.invoke("ws_close", { id: handle });
      conns.delete(handle);
    },
  };
}

// app.network 구현 — http(req) → 코어 network_http_request 위임. ns=플러그인 id 주입(타 ns 시크릿
// 탈취 차단 R2/R6 — 호출자가 ns 를 못 정한다). secretSubst=placeholder→secretKey(평문 0, Rust 경계 치환).
function createNetworkApi(deps: PluginApiDeps, ns: string) {
  return {
    http: async (req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      secretSubst?: Record<string, string>;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      return (await deps.invoke("network_http_request", {
        method: req.method,
        url: req.url,
        headers: req.headers ?? null,
        query: req.query ?? null,
        body: req.body ?? null,
        contentType: req.contentType ?? null,
        ns,
        secretSubst: req.secretSubst ?? null,
      })) as { status: number; headers: Record<string, string>; body: string };
    },
  };
}

export function buildPluginApi(
  manifest: PluginManifest,
  _dir: string,
  deps: PluginApiDeps,
): { api: SoksakPluginApi; tracker: DisposableTracker } {
  const tracker = new DisposableTracker();
  const id = manifest.id;
  const has = (p: PluginPermission) => manifest.permissions.includes(p);

  // 플러그인 호출 컨텍스트: 원격 아님(권한은 이 API 게이트가 담당 — §0-2 문서화된 모델).
  const pluginCtx: CommandContext = {};

  const executeGated = async (
    name: string,
    params?: Record<string, unknown>,
  ): Promise<CommandOutcome> => {
    if (isBlockedForPlugins(name)) {
      return denied(`플러그인은 관리 명령을 호출할 수 없음(§0-5): ${name}`);
    }
    const danger = deps.getCommandDanger(name);
    const need: PluginPermission =
      danger === "destructive"
        ? "commands:destructive"
        : danger === "inject"
          ? "commands:inject"
          : "commands";
    if (!has(need)) {
      return denied(`매니페스트 미선언 권한: ${need} (명령: ${name})`);
    }
    return deps.execute(name, params ?? {}, pluginCtx);
  };

  const api: SoksakPluginApi = {
    appVersion: deps.appVersion,
    pluginId: id,
    locale: () => useSettings.getState().language,

    events: {
      on: (event, fn) => {
        // 권한 게이트: 민감 이벤트(command.* 등)는 선언 권한이 있어야 구독 가능.
        // 동의 화면이 그 권한을 표시하므로 코어/터미널 접근이 사용자에게 고지된다.
        const need = EVENT_PERMISSIONS[event];
        if (need && !has(need)) {
          throw new Error(
            `이벤트 "${String(event)}" 구독은 "${need}" 권한 선언이 필요합니다`,
          );
        }
        return tracker.add(deps.on(event, fn));
      },
    },

    project: {
      current: () => deps.currentProject(),
    },

    settings: {
      get: (key) => {
        const defs = configDefaults(manifest);
        if (!(key in defs)) return undefined; // 스키마 밖 키는 노출 안 함
        return usePluginSettings
          .getState()
          .effective(id, key, defs[key], deps.currentProject()?.root ?? undefined);
      },
      all: () =>
        usePluginSettings
          .getState()
          .allEffective(id, configDefaults(manifest), deps.currentProject()?.root ?? undefined),
      onChange: (cb) => {
        const fire = () =>
          cb(
            usePluginSettings
              .getState()
              .allEffective(
                id,
                configDefaults(manifest),
                deps.currentProject()?.root ?? undefined,
              ),
          );
        // 값 변경(글로벌/프로젝트 오버라이드) + 활성 프로젝트 전환(다른 root → 다른 effective)에 재발화.
        const unSettings = usePluginSettings.subscribe(fire);
        const unProject = useSessions.subscribe((s, prev) => {
          if (s.activeId !== prev.activeId) fire();
        });
        return tracker.wrap(() => {
          unSettings();
          unProject();
        });
      },
    },

    commands: has("commands")
      ? {
          execute: executeGated,
          register: (name, spec) => {
            const declared = manifest.contributes.commands.find(
              (c) => c.name === name,
            );
            if (!declared) {
              throw new Error(
                `매니페스트 contributes.commands 에 선언되지 않은 명령: ${name}`,
              );
            }
            // 매니페스트 선언이 danger 의 권위(설치·동의 시점 가시성). 런타임 spec.danger 와
            // 매니페스트가 둘 다 있고 다르면 모순 → 거부. 매니페스트가 권위지만, 런타임만 danger 를
            // 선언한 경우(레거시)는 게이트 보존을 위해 런타임 값을 쓰되 매니페스트 선언을 촉구(warn).
            if (
              spec.danger !== undefined &&
              declared.danger !== undefined &&
              spec.danger !== declared.danger
            ) {
              throw new Error(
                `명령 danger 모순: ${name} — 매니페스트=${declared.danger}, 런타임=${spec.danger}`,
              );
            }
            const danger = declared.danger ?? spec.danger;
            if (declared.danger === undefined && spec.danger !== undefined) {
              console.warn(
                `[plugin:${id}] 명령 '${name}' 이 런타임 danger='${spec.danger}' 인데 매니페스트 contributes.commands 에 미선언 — 설치/동의 가시성 위해 매니페스트에 danger 선언 필요`,
              );
            }
            const full = pluginCommandName(id, name);
            deps.registerCommand(full, {
              description: spec.description,
              triggers: spec.triggers, // 호스트 catalogJson 이 base+triggers 합성(docs/I18N.md §3)
              params: spec.params ?? {},
              returns: spec.returns ?? "object",
              examples: spec.examples,
              danger, // 매니페스트 권위(없으면 런타임 fallback — 게이트 보존)
              // registry.execute 가 try/catch 로 INTERNAL 변환(§0-4).
              handler: (params) => spec.handler(params),
            });
            return tracker.wrap(() => deps.unregisterCommand(full));
          },
        }
      : undefined,

    // programs 기여는 완전 선언형 — loader 가 자동 등록(명령형 API 없음 §2.6).

    ui: has("ui") || has("ui:statusbar") || has("ui:titlebar") || has("ui:overlay:screen") || has("ui:overlay:pane")
      ? {
          registerView: (viewId, provider) => {
            const decl = manifest.contributes.views.find(
              (v) => v.id === viewId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.views 에 선언되지 않은 뷰: ${viewId}`,
              );
            }
            const remove = useViewRegistry
              .getState()
              .register(id, decl, provider);
            return tracker.wrap(remove);
          },
          registerFileViewer: (viewerId, provider) => {
            const decl = manifest.contributes.fileViewers.find(
              (f) => f.id === viewerId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.fileViewers 에 선언되지 않은 파일 뷰어: ${viewerId}`,
              );
            }
            const remove = useFileViewerRegistry
              .getState()
              .register(id, decl, provider);
            return tracker.wrap(remove);
          },
          // 배치 명령(plugin.view.open — M_P5 에서 등록)으로 위임.
          openView: (viewId, placement) =>
            deps.execute(
              "plugin.view.open",
              {
                view: qualifiedViewId(id, viewId),
                ...(placement ? { placement } : {}),
              },
              pluginCtx,
            ),
          // 아이콘 셋 등록 — 선언(contributes.iconSets) 외 거부 + 데이터 전수 검증
          // (registerView 와 동일 패턴). 전역 셋 id = "<pluginId>.<setId>".
          registerIconSet: (setId, data) => {
            const decl = manifest.contributes.iconSets.find(
              (s) => s.id === setId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.iconSets 에 선언되지 않은 셋: ${setId}`,
              );
            }
            const invalid = validateIconSetData(data);
            if (invalid) {
              throw new Error(`아이콘 셋 데이터 불량(${setId}): ${invalid}`);
            }
            const globalId = qualifiedViewId(id, setId);
            useIconRegistry.getState().register({
              id: globalId,
              name: localize(decl.title),
              data: data as IconSetData,
            });
            return tracker.wrap(() =>
              useIconRegistry.getState().unregister(globalId),
            );
          },
          // paneId 연관 상태바 아이템(claude-GUI 의 "gui" 등). id 는 플러그인 네임스페이스로
          // 충돌 방지. 같은 id 재호출 = 교체(active 토글 갱신). 반환 = 해지.
          // [RULE] 상태바는 콘텐츠 뷰("ui")와 다른 영역 → "ui:statusbar" 권한 필요.
          statusBarItem: (item) => {
            if (!has("ui:statusbar")) {
              throw new Error('statusBarItem 은 "ui:statusbar" 권한이 필요합니다');
            }
            return tracker.wrap(
              registerStatusBarItem({ ...item, id: `${id}:${item.id}` }),
            );
          },
          // 타이틀바 우측 컨트롤 옆 토글 아이콘. id 는 플러그인 네임스페이스로 충돌 방지.
          // [RULE] 타이틀바는 상태바("ui:statusbar")와 다른 영역 → "ui:titlebar" 권한 필요.
          registerHeaderAction: (action) => {
            if (!has("ui:titlebar")) {
              throw new Error('registerHeaderAction 은 "ui:titlebar" 권한이 필요합니다');
            }
            return tracker.wrap(
              registerHeaderAction({ ...action, id: `${id}:${action.id}` }),
            );
          },
          setViewBadge: (viewId, badge) =>
            useViewRegistry
              .getState()
              .setViewBadge(qualifiedViewId(id, viewId), badge),
          // 오버레이 입력 게이트(useUi overlayCount → browser_overlay_active). 콘텐츠 네이티브
          // webview 위 클릭 성립. [RULE] 오버레이 영역 → "ui:overlay:*" 권한 필요.
          setOverlayActive: (active) => {
            if (!(has("ui:overlay:screen") || has("ui:overlay:pane"))) {
              throw new Error('setOverlayActive 는 "ui:overlay:*" 권한이 필요합니다');
            }
            if (active) useUi.getState().pushOverlay();
            else useUi.getState().popOverlay();
          },
        }
      : undefined,

    editor: has("editor")
      ? {
          modules: { view: cmView, state: cmState, language: cmLanguage },
          registerExtension: (reg) =>
            tracker.wrap(
              useEditorRegistry.getState().registerExtension({
                pluginId: id,
                languages: reg.languages ?? null,
                extension: reg.extension,
              }),
            ),
          registerFormatter: (reg) => {
            const decl = manifest.contributes.formatters.find(
              (f) => f.id === reg.id,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.formatters 에 선언되지 않은 포매터: ${reg.id}`,
              );
            }
            return tracker.wrap(
              useEditorRegistry.getState().registerFormatter({
                pluginId: id,
                id: decl.id,
                title: localize(decl.title),
                languages: decl.languages,
                format: reg.format,
              }),
            );
          },
          getActiveFile: () => deps.activeFile(),
          setFileText: (viewId, text) => deps.setFileText(viewId, text),
        }
      : undefined,

    storage: has("storage")
      ? {
          read: async (key) => {
            const raw = (await deps.invoke("plugin_data_read", {
              id,
              key,
            })) as string | null;
            return raw == null ? null : (JSON.parse(raw) as unknown);
          },
          write: async (key, value) => {
            await deps.invoke("plugin_data_write", {
              id,
              key,
              value: JSON.stringify(value),
            });
          },
          list: async () =>
            (await deps.invoke("plugin_data_list", { id })) as string[],
        }
      : undefined,

    // 범용 데이터 스토어 — ns 는 항상 이 플러그인 id 로 주입(storage 와 동일 격리 원칙). 모든 호출은
    // Rust DbState(단일 진실)로 forward. watch 는 전 창 data-change 를 ns/coll/scope 로 필터.
    data: has("data")
      ? {
          kv: {
            get: (key) => deps.invoke("data_kv_get", { ns: id, key }),
            set: async (key, value) => {
              await deps.invoke("data_kv_set", { ns: id, key, value });
            },
            delete: (key) =>
              deps.invoke("data_kv_delete", { ns: id, key }) as Promise<boolean>,
            keys: (prefix) =>
              deps.invoke("data_kv_keys", { ns: id, prefix: prefix ?? null }) as Promise<
                string[]
              >,
          },
          define: async (collection, opts) => {
            await deps.invoke("data_define", {
              ns: id,
              coll: collection,
              indexes: opts.indexes ?? [],
              fts: opts.fts ?? [],
            });
          },
          put: (collection, doc, opts) =>
            deps.invoke("data_put", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              id: opts?.id ?? null,
              doc,
            }) as Promise<string>,
          get: (collection, recordId, opts) =>
            deps.invoke("data_get", {
              ns: id,
              coll: collection,
              id: recordId,
              scope: opts?.scope ?? null,
            }),
          delete: (collection, recordId, opts) =>
            deps.invoke("data_delete", {
              ns: id,
              coll: collection,
              id: recordId,
              scope: opts?.scope ?? null,
            }) as Promise<boolean>,
          query: (collection, opts) =>
            deps.invoke("data_query", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              filter: opts?.where ?? null,
              order: opts?.order ?? null,
              desc: opts?.desc ?? null,
              limit: opts?.limit ?? null,
              offset: opts?.offset ?? null,
            }) as Promise<unknown[]>,
          search: (collection, text, opts) =>
            deps.invoke("data_search", {
              ns: id,
              coll: collection,
              query: text,
              scope: opts?.scope ?? null,
              limit: opts?.limit ?? null,
            }) as Promise<unknown[]>,
          count: (collection, opts) =>
            deps.invoke("data_count", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              filter: opts?.where ?? null,
            }) as Promise<number>,
          watch: (collection, opts, cb) => {
            const un = deps.onDataChange((e) => {
              if (e.ns !== id || e.coll !== collection) return;
              if (opts?.scope != null && e.scope != null && e.scope !== opts.scope) {
                return;
              }
              cb(e);
            });
            return tracker.wrap(un);
          },
        }
      : undefined,

    // 암호화 시크릿 볼트 — ns 는 항상 이 플러그인 id 로 주입(app.data 와 동일 격리). 모든 호출은
    // Rust SecretsState(단일 진실)로 forward. get 없음 — 평문 readback 차단(주입 전용 2b).
    secrets: has("secrets")
      ? {
          set: async (key, value) => {
            await deps.invoke("secret_set", { ns: id, key, value });
          },
          has: (key) =>
            deps.invoke("secret_has", { ns: id, key }) as Promise<boolean>,
          delete: (key) =>
            deps.invoke("secret_delete", { ns: id, key }) as Promise<boolean>,
          keys: () => deps.invoke("secret_keys", { ns: id }) as Promise<string[]>,
          backend: () =>
            deps.invoke("secret_backend") as Promise<{
              backend: string;
              unlocked: boolean;
            }>,
        }
      : undefined,

    // 알림(=푸시) + 소리. 시스템 알림은 "notify" 권한 게이트(동의 화면 고지). 소리는 같은 capability.
    notify: has("notify")
      ? {
          push: (n) => pushNotification(n),
        }
      : undefined,
    sound: has("notify")
      ? {
          play: (s) => playSound(s),
          builtins: () => [...BUILTIN_SOUNDS],
        }
      : undefined,

    fs:
      has("fs:read") || has("fs:write")
        ? {
            readText: has("fs:read")
              ? async (path, offset) => {
                  const data = (await deps.invoke("read_text_file", {
                    path,
                    offset,
                  })) as {
                    content: string;
                    truncated: boolean;
                    total_bytes: number;
                  };
                  return {
                    text: data.content,
                    truncated: data.truncated,
                    totalBytes: data.total_bytes,
                  };
                }
              : undefined,
            readBinary: has("fs:read")
              ? (path) =>
                  deps.invoke("read_file_base64", { path }) as Promise<{
                    mime: string;
                    base64: string;
                  }>
              : undefined,
            writeText: has("fs:write")
              ? async (path, content) => {
                  await deps.invoke("write_text_file", { path, content });
                }
              : undefined,
            list: has("fs:read")
              ? (path, opts) =>
                  deps.invoke("list_children", { path, meta: opts?.meta })
              : undefined,
            // 코어 watcher 구독(폴링 없음). 비재귀 — 하위 폴더는 호출자가 따로 watch.
            // [RULE] 감시는 읽기의 일부(언제 다시 읽을지) → "fs:read" 게이트 공유.
            watch: has("fs:read")
              ? (dir, cb) => {
                  void deps.invoke("watch_dir", { path: dir });
                  const un = deps.onFsChange((changed) => {
                    if (changed === dir) cb(dir);
                  });
                  return tracker.wrap(() => {
                    un();
                    void deps.invoke("unwatch_dir", { path: dir });
                  });
                }
              : undefined,
          }
        : undefined,

    // [RULE] 클립보드 영역 — 능력이 다르면 권한도 분리: 읽기("clipboard:read": 내용 읽기 + 변경
    // 구독), 쓰기("clipboard:write": 내용 덮어쓰기). watch 는 읽기의 일부 → "clipboard:read"
    // 게이트 공유(fs.watch 선례). 코어가 OS별 네이티브 이벤트(Win/X11/Wayland)+macOS changeCount
    // 폴링을 흡수해 단일 clipboard-change 시그널로 노출 — 플러그인은 OS 분기를 보지 않는다.
    clipboard:
      has("clipboard:read") || has("clipboard:write")
        ? {
            readText: has("clipboard:read")
              ? () => deps.invoke("clipboard_read") as Promise<string>
              : undefined,
            writeText: has("clipboard:write")
              ? async (text: string) => {
                  await deps.invoke("clipboard_write", { text });
                }
              : undefined,
            watch: has("clipboard:read")
              ? (cb: (e: { text: string }) => void) => {
                  void deps.invoke("clipboard_watch_start");
                  const un = deps.onClipboardChange((text) => cb({ text }));
                  return tracker.wrap(() => {
                    un();
                    void deps.invoke("clipboard_watch_stop");
                  });
                }
              : undefined,
          }
        : undefined,

    git: has("git:read")
      ? {
          log: (opts) => {
            const path = opts?.path ?? deps.currentProject()?.root;
            if (!path) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_log", {
              path,
              limit: opts?.limit,
              skip: opts?.skip,
            });
          },
          show: (commit, path) => {
            const p = path ?? deps.currentProject()?.root;
            if (!p) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_show", { path: p, commit });
          },
          diff: async (opts) => {
            const path = opts?.path ?? deps.currentProject()?.root;
            if (!path) throw new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요");
            return (await deps.invoke("git_diff", {
              path,
              file: opts?.file,
              commit: opts?.commit,
              staged: opts?.staged,
            })) as string;
          },
          status: (path) => {
            const p = path ?? deps.currentProject()?.root;
            if (!p) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_status", { path: p });
          },
        }
      : undefined,

    // [RULE] 터미널 영역 — 능력이 다르면 권한도 분리: 관찰("terminal": command.* 스냅샷),
    // 화면 읽기("terminal:read": 버퍼 내용·갱신 — 전 화면 텍스트), 입력 쓰기("terminal:write":
    // PTY 키 주입). 셋 다 별도 권한.
    terminal:
      has("terminal") || has("terminal:read") || has("terminal:write")
        ? {
            ...(has("terminal")
              ? {
                  runningCommands: () => runningCommands(),
                  getCwd: (paneId: string) => deps.getCwd(paneId),
                  onCwd: (paneId: string, cb: (cwd: string) => void) =>
                    tracker.wrap(deps.subscribeCwd(paneId, cb)),
                  onCommandFinished: (paneId: string, cb: () => void) =>
                    tracker.wrap(deps.subscribeCommandFinished(paneId, cb)),
                }
              : {}),
            ...(has("terminal:read")
              ? {
                  readBuffer: (paneId: string, lines?: number) =>
                    readHostBuffer(paneId, lines),
                  onOutput: (paneId: string, cb: () => void) =>
                    tracker.wrap(subscribeOutput(paneId, cb)),
                }
              : {}),
            ...(has("terminal:write")
              ? {
                  sendText: (paneId: string, text: string) =>
                    sendInputToHost(paneId, text),
                }
              : {}),
          }
        : undefined,
    process: has("process") ? createProcessApi(deps, tracker, id) : undefined,
    network: has("network") ? createNetworkApi(deps, id) : undefined,
    ws: has("network") ? createWsApi(deps, tracker) : undefined,
    bus: {
      emit: (topic: string, payload: unknown) => busEmit(topic, payload),
      on: (topic: string, fn: (payload: unknown) => void) =>
        tracker.wrap(busOn(topic, fn)),
    },
  };

  return { api, tracker };
}
