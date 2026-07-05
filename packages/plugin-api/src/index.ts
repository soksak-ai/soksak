// @soksak-ai/plugin-api — soksak 플러그인 런타임 API 계약 타입(ctx.app·Plugin·PluginContext).
// 타입 전용 패키지 — 순수 개발 편의(선택 devDep), 런타임 0.
//
// 코어를 import 하지 않고 타입을 *독립* 정의한다(발행 패키지는 코어 소스에 접근 불가). 단일진실은
// 코어 api.ts 의 양방향 호환 테스트가 컴파일로 강제한다 — drift 가 나면 코어 tsc 가 RED. 매니페스트·
// 배치 타입은 @soksak-ai/plugin-spec 한 곳에서 가져온다(중복 0).
import type { PluginManifest, ViewPlacement, MapEntry } from "@soksak-ai/plugin-spec";
export type { PluginManifest, ViewPlacement } from "@soksak-ai/plugin-spec";

/** register* 가 돌려주는 해지 토큰. ctx.subscriptions 에 넣으면 비활성화 시 자동 dispose. */
// 사이드카(engine 모듈) 채널 핸들 — 불투명 JSON 채널(의미는 플러그인↔사이드카 사적 계약).
export interface SidecarHandle {
  /** 불투명 요청 → 모듈의 동기 응답(JSON). */
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** 모듈 이벤트 구독 — {event, ...payload} 의 event 필드로 demux. 반환=해지. */
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => Disposable;
  /** 채널 해제(모듈은 상주 유지). 멱등. */
  close: () => Promise<void>;
}

export interface Disposable {
  dispose(): void;
}

/** 명령 파라미터 스펙(JSON 직렬화 — CLI/MCP/문서 생성에 그대로 쓰임). */
export interface ParamSpec {
  type: "string" | "number" | "boolean" | "string[]" | "number[]" | "json";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  default?: unknown;
}

export type CmdErrCode =
  | "TARGET_NOT_FOUND"
  | "LAST_ITEM"
  | "INVALID_PARAMS"
  | "CONSENT_REQUIRED"
  | "CASCADE_REQUIRED"
  | "NOT_EXPOSED";

// 표준 응답 봉투 — 성공/실패 대칭. docs/MESSAGE-PROTOCOL.md 단일진실.
//   ok=성공/실패, code=성공 "OK"/도메인·실패 ErrCode, message=사람이 읽는 한 줄 표준 답변,
//   data=기계 페이로드(선택, 중첩). 버블은 message 를 렌더한다.
export type ErrCode =
  | CmdErrCode
  | "INTERNAL"
  | "TIMEOUT"
  | "UNKNOWN_COMMAND"
  | "INVALID_PARAMS"
  | "PERMISSION_DENIED";
export interface CommandOutcome {
  ok: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}
export type CommandError = CommandOutcome & { ok: false };

/** 플러그인이 register 하는 명령 스펙. description=영어 base(LLM 발견), triggers=언어별 트리거어. */
export interface PluginCommandSpec {
  description: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  returns?: string;
  examples?: readonly string[];
  danger?: "destructive" | "inject";
  /** 표준 답변(MESSAGE-PROTOCOL §3) — 성공 data 를 사람이 읽는 한 줄 message 로. 미제공이면
   *  code 에코("OK")로 열화하고 로더가 경고한다. */
  summarize?: (data: Record<string, unknown>) => string;
  /** 낭독 스펙(MESSAGE-PROTOCOL 낭독 항) — 생략=true(실행 기록이 낭독 대상). false=절대 낭독
   *  금지: 낭독을 수행하는 명령(say 류)만 선언(무한 전파의 유일한 차단점). */
  tts?: boolean;
  /** 계측 스펙(MESSAGE-PROTOCOL §4) — false=실행이 활동 트레이스에서 제외. 관찰의 부산물로
   *  스트림을 늘리는 명령(say 류)만 선언. */
  trace?: false;
  /** inv = 이 호출의 실행 컨텍스트(§5 상속) — 중첩 명령 실행은 반드시 inv.execute 로:
   *  부모의 유래(origin)·상관(parentId)이 자식에 계승된다. */
  handler: (
    params: Record<string, unknown>,
    inv?: PluginInvocation,
  ) => Promise<object> | object;
}

/** 명령 핸들러에 주입되는 호출 컨텍스트 — 중첩 실행의 유래·상관 상속 통로(MESSAGE-PROTOCOL §5). */
export interface PluginInvocation {
  origin?: string;
  parent?: string;
  execute: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; code: string; message: string; data?: Record<string, unknown> }>;
}

/** data.watch 가 받는 변경 페이로드. coll/scope/id 는 연산에 따라 null. */
export interface DataChangeEvent {
  ns: string;
  coll: string | null;
  scope: string | null;
  op: string;
  id: string | null;
}

export interface Bookmark {
  url: string;
  title: string;
}

/** 코어가 events.on 으로 알리는 호스트 상태 변화. */
export interface PluginEventMap {
  "project.changed": { projectId: string; root: string | null };
  "project.created": { projectId: string; root: string | null };
  "view.activated": { projectId: string; viewId: string; kind: string; path?: string };
  // 진행 델타(MESSAGE-PROTOCOL §2) — 사이드카 이벤트·AI thinking 을 소비 플러그인이 발행.
  "command.progress": { command?: string; delta?: unknown; source?: string };
  "file.opened": { projectId: string; viewId: string; path: string };
  "file.closed": { projectId: string; viewId: string; path: string };
  "file.saved": { projectId: string; viewId: string; path: string };
  "theme.changed": { name: string; mode: "light" | "dark" };
  "locale.changed": { language: string };
  "app.focus": { focused: boolean };
  /** 창 가장자리 드래그 라이브 리사이즈 시작(true)/끝(false). 코어 네이티브 신호 중계 —
   *  뷰 플러그인이 드래그 중 무거운 작업(fit·네이티브 재배치)의 빈도를 낮추고 끝에 1회
   *  정확히 스냅하기 위한 채널. 권한 불요. per-window(이 창의 드래그만 도착). */
  "window.live-resize": { active: boolean };
  /** 패널 디바이더 드래그 제스처 시작(true)/끝(false) — window.live-resize(창 가장자리)와
   *  동형의 레이아웃-내부 제스처 채널. 네이티브 표면 제공자(브라우저 뷰 등)가 드래그 중
   *  bounds 커밋을 유예하고 시각 연속 스탠드인(freeze-frame)을 띄우는 근거 신호.
   *  끝(false)은 최종 레이아웃 커밋 이후에 도착한다 — 그 시점 슬롯 rect 가 최종값. 권한 불요. */
  "layout.resize-gesture": { active: boolean };
  "bookmarks.changed": { bookmarks: Bookmark[] };
  "command.started": {
    projectId: string | null;
    paneId: string;
    commandLine: string;
    cwd: string | null;
  };
  "command.finished": { projectId: string | null; paneId: string };
  activity: {
    seq: number;
    ts: number;
    kind: string;
    source: string;
    payload: Record<string, unknown>;
    ownWindow: boolean;
  };
  "turn.ended": {
    projectId: string | null;
    root: string | null;
    paneId: string | null;
    source: "shell" | "idle" | "acp";
    command?: string | null;
    cwd?: string | null;
  };
}

export type ViewBadge = number | "dot" | null;

/** 뷰가 코어에 보고하는 상태(code=기계 식별자, message=사람 표시). blocking code(dirty/busy/running)는 닫기 가드를 발동. */
export interface ViewStatus {
  code: string;
  message?: string;
}

/** registerView provider 의 mount 가 받는 컨텍스트. */
export interface PluginViewContext {
  projectId: string;
  root: string | null;
  paneId: string | null;
  /** 콘텐츠 배치 뷰의 안정 인스턴스 키(예: app.webview.label(viewId)). 사이드바 배치는 null. */
  viewId: string | null;
  /** 이 뷰가 마운트 시 1회 자동 실행할 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 실행).
   *  프로그램 선언(ContributedProgram.command)이 source. 뷰 종류 무관 채널 — 자동 실행 여부는
   *  뷰 구현이 결정한다(터미널 뷰만 PTY 로 실행). 명령 없으면 null. */
  command: string | null;
  /** 복원 seam(B3) — 재시작 복원 마운트면 관찰됐던 런타임(cwd). 새 뷰는 null.
   *  터미널 뷰는 restore.cwd 에서 spawn(마지막 작업 위치 복원). */
  restore: { cwd: string | null } | null;
  setBadge: (badge: ViewBadge) => void;
  /** 이 뷰의 상태를 보고(R1) — null=회수. 콘텐츠 배치 뷰만 유효(close guard). */
  setStatus: (status: ViewStatus | null) => void;
  /** 이 뷰의 탭 제목 동적 갱신(콘텐츠 배치만 — 예: 브라우저 페이지 제목). 빈 값 무시. 사이드바=no-op. */
  setTitle: (title: string) => void;
}

/** 플러그인이 구현하는 뷰. React 비요구 — 컨테이너 DOM 에 직접 그린다. */
export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
}

/** registerFileViewer provider 의 mount 가 받는 컨텍스트. */
export interface FileViewerContext {
  viewId: string;
  path: string;
  projectId: string;
  root: string | null;
  setDirty: (dirty: boolean) => void;
}

export interface FileViewerProvider {
  mount(container: HTMLElement, ctx: FileViewerContext): void;
  unmount?(container: HTMLElement): void;
}

export interface StatusBarItem {
  id: string;
  paneId: string;
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}

export interface HeaderAction {
  id: string;
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}

export interface NotifyAction {
  label: string;
  deepLink: string;
}

export interface NotificationInput {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
  sound?: string;
  deepLink?: string;
  tag?: string;
  actions?: NotifyAction[];
  data?: Record<string, unknown>;
}

export type SettingValue = boolean | number | string | string[] | MapEntry[];

/** ctx.app — 플러그인이 받는 호스트 표면 전체. 옵셔널 필드는 해당 권한 미선언 시 undefined(권한 게이트). */
export interface SoksakPluginApi {
  appVersion: string;
  pluginId: string;
  locale: () => string;
  commands?: {
    /** opts.origin — 자동 행위의 자기 선언(§5): 사람 의도가 아닌 실행(백필 조회·낭독 등)은
     *  "internal". 기록은 그대로, 노출(흐림·무낭독)만 낮아진다. */
    execute: (
      name: string,
      params?: Record<string, unknown>,
      opts?: { origin?: string },
    ) => Promise<CommandOutcome>;
    register: (name: string, spec: PluginCommandSpec) => Disposable;
  };
  events: {
    on: <K extends keyof PluginEventMap>(
      event: K,
      fn: (payload: PluginEventMap[K]) => void,
    ) => Disposable;
    /** 진행 델타 발행(MESSAGE-PROTOCOL §2) — 장시간 명령의 실행 중 상태를 활동 스트림에 흘린다.
     *  사이드카 이벤트 → 표준 progress 변환은 소비 플러그인 책임(A14). source=플러그인 id 고정. */
    progress: (command: string, delta: unknown) => void;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
    registerFileViewer: (viewerId: string, provider: FileViewerProvider) => Disposable;
    openView: (viewId: string, placement?: ViewPlacement) => Promise<CommandOutcome>;
    registerIconSet: (setId: string, data: unknown) => Disposable;
    statusBarItem: (item: StatusBarItem) => Disposable;
    registerHeaderAction: (action: HeaderAction) => Disposable;
    setOverlayActive: (active: boolean) => void;
    setViewBadge: (viewId: string, badge: number | "dot" | null) => void;
  };
  storage?: {
    read: (key: string) => Promise<unknown>;
    write: (key: string, value: unknown) => Promise<void>;
    list: () => Promise<string[]>;
  };
  data?: {
    kv: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      keys: (prefix?: string) => Promise<string[]>;
      /** 이 플러그인 ns 의 kv 변경(set/delete) 전 창 구독 — 변경된 key 콜백. 해지 함수 반환. */
      watch: (cb: (key: string | null) => void) => Disposable;
    };
    define: (collection: string, opts: { indexes?: string[]; fts?: string[] }) => Promise<void>;
    put: (
      collection: string,
      doc: Record<string, unknown>,
      opts?: { scope?: string; id?: string },
    ) => Promise<string>;
    get: (collection: string, id: string, opts?: { scope?: string }) => Promise<unknown>;
    delete: (collection: string, id: string, opts?: { scope?: string }) => Promise<boolean>;
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
    search: (
      collection: string,
      text: string,
      opts?: { scope?: string; limit?: number },
    ) => Promise<unknown[]>;
    count: (
      collection: string,
      opts?: { scope?: string; where?: Record<string, unknown> },
    ) => Promise<number>;
    /** retention(R5) — (coll,scope) 수가 cap 초과 시 oldest(created) 축출. 반환=삭제 수. */
    retentionTrim: (collection: string, scope: string, cap: number) => Promise<number>;
    /** retention(R5) — created < cutoffMs 인 레코드 삭제(시간축). 반환=삭제 수. */
    retentionReap: (collection: string, cutoffMs: number) => Promise<number>;
    watch: (
      collection: string,
      opts: { scope?: string } | undefined,
      cb: (e: DataChangeEvent) => void,
    ) => Disposable;
  };
  secrets?: {
    set: (key: string, value: string) => Promise<void>;
    has: (key: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
    keys: () => Promise<string[]>;
    backend: () => Promise<{ backend: string; unlocked: boolean }>;
  };
  notify?: {
    push: (n: NotificationInput) => Promise<void>;
  };
  sound?: {
    play: (sound: string) => Promise<void>;
    builtins: () => string[];
  };
  fs?: {
    readText?: (
      path: string,
      offset?: number,
    ) => Promise<{ text: string; truncated: boolean; totalBytes: number }>;
    readBinary?: (path: string) => Promise<{ mime: string; base64: string }>;
    /** 로컬 파일 → webview 로드 가능 URL(코어 표준). 같은 path 멱등. "fs:read" 게이트. */
    url?: (path: string) => Promise<string>;
    writeText?: (path: string, content: string) => Promise<void>;
    list?: (path: string, opts?: { meta?: boolean }) => Promise<unknown>;
    watch?: (dir: string, cb: (dir: string) => void) => Disposable;
  };
  clipboard?: {
    readText?: () => Promise<string>;
    writeText?: (text: string) => Promise<void>;
    watch?: (cb: (e: { text: string }) => void) => Disposable;
  };
  git?: {
    log: (opts?: { path?: string; limit?: number; skip?: number }) => Promise<unknown>;
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
    runningCommands?: () => { paneId: string; commandLine: string; cwd: string | null }[];
    sendText?: (paneId: string, text: string) => boolean;
    readBuffer?: (paneId: string, lines?: number) => string | undefined;
    onOutput?: (paneId: string, cb: () => void) => Disposable;
    getCwd?: (paneId: string) => string | undefined;
    onCwd?: (paneId: string, cb: (cwd: string) => void) => Disposable;
    onCommandFinished?: (paneId: string, cb: () => void) => Disposable;
  };
  process?: {
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
    write: (handle: number, data: string) => Promise<void>;
    /** stdin 닫기(자식은 계속 실행) — 파이프 입력을 read-to-end 하는 자식에 EOF 전달. 멱등. */
    closeStdin: (handle: number) => Promise<void>;
    onData: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    onStderr: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    onExit: (handle: number, cb: (code: number) => void) => Disposable;
    kill: (handle: number) => Promise<void>;
  };
  /** 사이드카(engine 모듈) 채널 — 매니페스트 sidecars[] 선언 필수, "sidecar" 권한(caution).
   *  코어는 맹목 relay(메시지 의미는 플러그인↔사이드카 사적 계약 — docs/SIDECARS.md). */
  sidecar?: {
    open: (name: string) => Promise<SidecarHandle>;
  };
  ws?: {
    connect: (url: string) => Promise<number>;
    send: (handle: number, text: string) => Promise<void>;
    onMessage: (handle: number, cb: (text: string) => void) => Disposable;
    onClose: (handle: number, cb: () => void) => Disposable;
    close: (handle: number) => Promise<void>;
  };
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
  bus: {
    emit: (topic: string, payload: unknown) => void;
    on: (topic: string, fn: (payload: any) => void) => Disposable;
  };
  project: {
    current: () => { id: string; root: string | null } | null;
  };
  settings: {
    get: (key: string) => SettingValue | undefined;
    all: () => Record<string, SettingValue>;
    onChange: (cb: (all: Record<string, SettingValue>) => void) => Disposable;
  };
}

/** activate(ctx) 로 전달되는 컨텍스트. */
export interface PluginContext {
  app: SoksakPluginApi;
  manifest: PluginManifest;
  dir: string;
  subscriptions: Disposable[];
}

/** 플러그인 entry — main.js 의 `export default`. 코어 loader 가 activate(ctx) 를 호출한다. */
export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
