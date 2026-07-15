// 플러그인 API — activate(ctx) 로 전달되는 호스트 표면(soksak-spec-plugin v1 §0).
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
import { browserLabel, currentWindowLabel } from "../lib/webviewLabels";
import { busEmit, busOn } from "./bus";
import {
  onPluginEvent,
  emitPluginEvent,
  type Disposable,
  type PluginEventMap,
} from "./hooks";
import { gateContribution } from "./conformance";
import {
  useViewRegistry,
  type PluginViewProvider,
} from "./viewRegistry";
import {
  useFileViewerRegistry,
  type FileViewerProvider,
} from "./fileViewerRegistry";
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
  subscribeOutput,
} from "../terminal/paneHosts";
import {
  registerPtyObservation,
  feedPtyOutput,
  disposePtyObservation,
  registerPtyIo,
  getPtyIo,
} from "../terminal/ptyObservationStore";
import { EVENT_PERMISSIONS } from "./hooks";
import type { IconSetData } from "../ui/icons/types";
import {
  configDefaults,
  contractRequirementSatisfiedBy,
  pluginCommandName,
  qualifiedViewId,
  type ContractProviderRef,
  type ContractRequirement,
  type PluginManifest,
  type PluginPermission,
  type ViewPlacement,
} from "./spec";
import { localize } from "../i18n";
import { useSettings } from "../state/settings";
import { usePluginSettings, type SettingValue } from "../state/pluginSettings";
import { useSessions } from "../state/sessions";

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
  // 대상 플러그인이 선언한 계약(매니페스트 implements) — 호출 경계의 계약-핀 판정에 쓴다.
  // 코어는 여기서도 구현체를 이름으로 알지 않는다: 계약 id 집합만 비교한다.
  implementsOf?: (pluginId: string) => ContractProviderRef[];
  on: typeof onPluginEvent;
  currentProject: () => { id: string; root: string | null } | null;
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
  // 코어가 browser.rs 에서 emit 하는 webview 이벤트(`browser-<event>`) label 필터 구독 — app.webview.on.
  subscribeWebview: (
    label: string,
    event: string,
    cb: (payload: Record<string, unknown>) => void,
  ) => () => void;
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
  /** 표준 답변(MESSAGE-PROTOCOL §3) — 성공 data 를 사람이 읽는 한 줄 message 로. 미제공이면
   *  답이 라벨로 열화하고 로더가 경고한다(M5 에서 필수화). 준거=runbook ok()/err(). */
  message?: (data: Record<string, unknown>) => string;
  /** @deprecated message 로 개명 — M5 sweep 전환기 구명. 새 플러그인은 message 를 쓴다. */
  summarize?: (data: Record<string, unknown>) => string;
  /** 낭독 문장(speak, §3) — 낭독 축은 이것 하나: speak 있으면 성공·실패 불문 speak(outcome)가
   *  문장, 없으면 message 폴백, "" = 침묵. say 류는 speak: () => "" 로 되먹임을 끊는다. */
  speak?: (out: { ok: boolean; code: string; message: string; data?: Record<string, unknown> }) => string;
  /** 계측 스펙(MESSAGE-PROTOCOL §4) — false=실행이 활동 트레이스에서 제외. 관찰의 부산물로
   *  스트림을 늘리는 명령(say 류 — 낭독 1회당 실행 기록 1개가 쌓인다)만 선언. */
  trace?: false;
  /** hint(가능성의 제시) — 성공 시 data, 실패 시 {code,message} 를 받아 이어서 할 수 있는
   *  명령을 최대 3개 제안한다. 지시가 아니라 제시 — 받은 쪽의 판단을 돕는 정보다. */
  hint?: (
    data: Record<string, unknown>,
    ctx: PluginInvocation,
  ) => { cmd: string; why: string }[];
  /** inv = 이 호출의 실행 컨텍스트(§5 상속). 핸들러가 다른 명령을 중첩 실행할 땐 반드시
   *  inv.execute 를 쓴다 — 부모의 유래(origin: 스케줄 발화 등)와 상관(parentId: 대화 턴)이
   *  자식 실행에 계승된다. app.commands.execute 로 부르면 사람 유래로 위장돼 낭독·강조가
   *  오염된다(실측: 스케줄 reconcile 의 중첩 조회가 매 발화 낭독됨). */
  handler: (
    params: Record<string, unknown>,
    inv?: PluginInvocation,
  ) => Promise<object> | object;
}

/** 명령 핸들러에 주입되는 호출 컨텍스트 — 중첩 실행의 유래·상관 상속 통로(§5). */
export interface PluginInvocation {
  /** 실행 유래 — 생략=사람, "schedule"=스케줄 발화 등. */
  origin?: string;
  /** 상관 부모(대화 턴 id) — 있으면 이 실행은 그 턴의 세트다. */
  parent?: string;
  /** 부모 컨텍스트를 계승하는 중첩 실행 — 핸들러 안에서의 명령 호출은 이걸로. */
  execute: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; code: string; message: string; data?: Record<string, unknown> }>;
}

// 스케줄러 트리거(코어 schedule.rs Trigger 와 동형 — wire 형태 그대로 전달). every_ms 는 코어 serde
// 필드명과 일치(매핑 없는 얇은 forward). reconcile = 타이머 없는 poke 이벤트 트리거.
export type SchedulerTrigger =
  | { kind: "at"; at: number } // 절대 ms 1회(과거면 즉시).
  | { kind: "every"; every_ms: number; anchor?: number } // 고정 간격 주기(anchor 격자).
  | { kind: "cron"; expr: string } // 5필드 cron(UTC).
  | { kind: "reconcile" }; // 등록 시 1회(부팅 스캔) + poke 시.

export interface SchedulerRetry {
  max: number; // 최대 재시도 횟수(0=없음).
  base_ms: number; // backoff 기준.
  max_ms: number; // backoff 상한.
}

export interface SchedulerJobView {
  id: string;
  trigger: SchedulerTrigger;
  command: string;
  params: Record<string, unknown>;
  next_at: number | null; // 다음 예정 발화(null=대기/완료).
  running: boolean;
  concurrency: number;
}

export interface SoksakPluginApi {
  appVersion: string;
  pluginId: string;
  // 호스트 표시 언어(권한 불요 컨텍스트 §3.5) — 변경은 locale.changed 이벤트.
  locale: () => string;
  /** 이 플러그인 인스턴스가 사는 창 label(멀티윈도우 — 창별 상태·자격 기록용). */
  windowLabel: () => string;
  commands?: {
    /** opts.origin — 자동 행위의 자기 선언(§5): 사람 의도가 아닌 실행(백필 조회·낭독 등)은
     *  "internal" 을 선언한다. 기록은 그대로 되고 노출(흐림·무낭독)만 낮아진다. */
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
    /** 진행 델타 발행(MESSAGE-PROTOCOL §2) — 장시간 명령이 실행 중 "무엇을 하는 중인지"를
     *  활동 스트림에 흘린다. 사이드카 이벤트를 표준 progress 로 변환하는 책임은 소비 플러그인에
     *  있다(A14 — 코어는 blind relay). source 는 플러그인 id 로 고정 — 발행 주체가 항상 보인다. */
    progress: (command: string, delta: unknown) => void;
  };
  /** 활동 로그 자기기술 발행 — 플러그인이 자기 도메인 활동을 코어 브리지 없이 직접 싣는다(§3).
   *  표시=message(플러그인 i18n), 낭독=선택 speak. 소비자는 kind 무지로 이 둘만 렌더. source=id 고정. */
  activity: {
    publish: (
      kind: string,
      entry: { message: string; speak?: string } & Record<string, unknown>,
    ) => void;
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
      /** 이 플러그인 ns 의 kv 변경(set/delete) 전 창 구독 — CLI/MCP·다른 창 변경을 폴링 0 으로
       *  반영. 콜백은 변경된 key. collection 변경은 제외(그건 data.watch). 해지 함수 반환. */
      watch: (cb: (key: string | null) => void) => Disposable;
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
    /** retention(R5) — (coll,scope) 수가 cap 초과 시 oldest(created) 축출. 반환=삭제 수. 영속 컬렉션이 호출. */
    retentionTrim: (collection: string, scope: string, cap: number) => Promise<number>;
    /** retention(R5) — created < cutoffMs 인 레코드 삭제(시간축). 반환=삭제 수. */
    retentionReap: (collection: string, cutoffMs: number) => Promise<number>;
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
  /** 범용 스케줄러(코어 — at/every/cron 으로 명령 자동 발화, reconcile 로 상태-틱 발화). 시간 기반은
   *  영속(crash 복구). 한 작업은 자기 자신과 동시 2회 안 돎(lease). 실패 시 backoff 재시도. "schedule" 권한. */
  scheduler?: {
    /** 작업 등록(멱등 — id 지정 시 교체). 반환=id. command=발화할 registry 명령. retry/concurrency 선택. */
    register: (job: {
      trigger: SchedulerTrigger;
      command: string;
      params?: Record<string, unknown>;
      id?: string;
      retry?: SchedulerRetry;
      concurrency?: number;
      /** 발화 1회당 명령 응답 대기 상한(ms) — 비-프로세스 작업(notify.show 등) 전용. 미지정 30s,
       *  코어가 [1s,3600s] 클램프. process_lease 작업은 이 값 무시(프로세스-생존 lease). */
      timeout_ms?: number;
      /** 프로세스-생존 lease opt-in. true 시: 발화 명령(exec-one)이 프로세스를 돌리고 onExit 까지 reply 를
       *  보류하면, 코어는 reply(=프로세스 exit)까지 lease 를 쥐고 기다린다 — 도는 동안(검색 1h 든) 절대
       *  안 자른다. 정상 exit→ok, crash→ok:false→backoff. 좀비(reply 영영 없음)만 zombie_backstop_ms 에 거둠. */
      process_lease?: boolean;
      /** 프로세스-생존 작업의 좀비 backstop(ms, claim 이후). reply 가 영영 안 올 때만 거둔다. null=무한
       *  (reply/cancel 까지, 사람 개입). process_lease 시 미지정이면 3h(10_800_000) 기본. */
      zombie_backstop_ms?: number | null;
    }) => Promise<string>;
    /** 즉시 발화 요청 — id 지정 시 그 작업, 미지정 시 모든 reconcile 작업(완료 트리거·외부 변화 반영). */
    poke: (id?: string) => Promise<void>;
    /** 작업 취소(영속도 제거, 발화 중 프로세스 작업은 대기 즉시 깨움). 있었으면 true. */
    cancel: (id: string) => Promise<boolean>;
    /** 등록된 작업 목록(next_at 오름차순). */
    list: () => Promise<SchedulerJobView[]>;
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
    /** 로컬 파일 → webview 로드 가능 URL(코어 표준). 같은 path 멱등. "fs:read" 게이트. */
    url?: (path: string) => Promise<string>;
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
  /** 코어가 임베드/구동하는 child webview(WKWebView) — 브라우저 같은 콘텐츠 뷰가 소유. "webview" 권한.
   *  네이티브 webview 는 코어가 label 키로 생성/소유, 플러그인은 label 로 구동(JS 가 WKWebView 못 만듦).
   *  macOS 우선 — eval/inject 는 macOS 한정(비-macOS graceful 에러/no-op). */
  webview?: {
    /** viewId → 전역 유일 label(창 네임스페이스 `b-<win>-<view>`). webviewLabels 단일 진실. */
    label: (viewId: string) => string;
    /** child webview 생성 + 슬롯 rect 에 임베드. 이미 있으면 no-op. */
    open: (
      label: string,
      o: { url: string; x: number; y: number; w: number; h: number },
    ) => Promise<void>;
    /** 슬롯 rect 동기화(분할/리사이즈 — 프레임당 1회 권장). */
    bounds: (label: string, x: number, y: number, w: number, h: number) => Promise<void>;
    /** 표시/숨김(탭 전환·최대화의 숨김 슬롯). */
    visible: (label: string, visible: boolean) => Promise<void>;
    /** URL 이동. */
    navigate: (label: string, url: string) => Promise<void>;
    /** URL 을 독립 OS 창(새 브라우저 윈도우)으로 연다. label 키 webview 와 무관 — 코어가 popup
     *  윈도우를 직접 만든다(범용 webview 호스트 표면 — 새 링크를 새 창으로 여는 플러그인이 쓴다). */
    openWindow: (url: string) => Promise<void>;
    /** 세션 히스토리 이동(delta=-1 뒤/+1 앞). */
    history: (label: string, delta: number) => Promise<void>;
    /** 로딩 정지(WKWebView stopLoading) — 툴바 reload↔stop 토글용. */
    stop?: (label: string) => Promise<void>;
    /** OS 인스펙터(devtools) 토글 → 열림 여부. */
    devtools: (label: string) => Promise<boolean>;
    /** 페이지에서 JS 실행 후 결과 문자열 반환(AI/E2E DOM 제어). macOS 한정. */
    eval: (label: string, js: string) => Promise<string>;
    /** init script 주입(document-start/end, 매 내비게이션 재주입). macOS 한정(비-macOS no-op).
     *  반환 Disposable 은 추적용 — WKUserScript 개별 제거는 미지원(webview 수명까지 유지). */
    injectScript: (
      label: string,
      code: string,
      phase?: "document-start" | "document-end",
    ) => Disposable;
    /** webview 이벤트 구독: "nav"({url})·"title"({title})·"status"·"open-external"({url}). 반환=해지. */
    on: (
      label: string,
      event: "nav" | "title" | "status" | "open-external" | "loading",
      cb: (payload: Record<string, unknown>) => void,
    ) => Disposable;
    /** 현재 살아있는 webview label 목록(prefix 필터). GC/정리용. */
    list: (prefix?: string) => Promise<string[]>;
    /** webview 종료 + 정리. */
    close: (label: string) => Promise<void>;
    /** 창 합성 캡처를 rect(CSS px, 창 좌표)로 crop 한 PNG data URL. 가림 상태에서도 캡처.
     *  드래그 중 네이티브 표면의 시각 연속 스탠드인(freeze-frame — layout.resize-gesture 와 짝). */
    captureRegion: (rect: { x: number; y: number; w: number; h: number }) => Promise<string>;
  };
  /** PTY 백드 터미널 세션 spawn + raw 바이트 IO(터미널 플러그인이 xterm 구동). "pty" 권한.
   *  process 와 달리 PTY(flow control·셸 통합·SOKSAK_* env 주입은 코어 pty.rs 소유). 출력은 onData 스트림. */
  pty?: {
    /** PTY 세션 spawn → id. windowLabel 은 코어가 현재 창으로 주입. replay = 화면 복원 제어(배관):
     *  없음=기본(데몬 재생·cold 주입, 코어 소유), "none"=소비자가 화면 소유(코어 복원 억제),
     *  {fromSeq}=raw 링을 그 seq 부터 부착(레이스-프리 warm 핸드오프). 코어는 페인트 불해석. */
    spawn: (opts: {
      cols: number;
      rows: number;
      cwd?: string;
      shell?: string;
      paneId?: string;
      replay?: "none" | { fromSeq: number };
    }) => Promise<number>;
    /** PTY 에 입력 쓰기(키 입력·붙여넣기). */
    write: (id: number, data: string) => Promise<void>;
    /** 터미널 크기 변경(SIGWINCH). */
    resize: (id: number, cols: number, rows: number) => Promise<void>;
    /** flow control ack — 처리한 바이트 수 보고(커널 reader 재개). */
    ack: (id: number, bytes: number) => Promise<void>;
    /** 세션 종료 + 정리. */
    close: (id: number) => Promise<void>;
    /** PTY 출력(raw 바이트) 구독. 등록 전 도착분은 버퍼되어 유실 0. 반환=해지. */
    onData: (id: number, cb: (data: Uint8Array) => void) => Disposable;
    /** PATH 에서 셸/바이너리 경로 해소(없으면 null). */
    which: (bin: string) => Promise<string | null>;
    /** 이 paneId 의 IO 핸들러(화면 읽기·입력 쓰기)를 substrate 에 등록 → app.terminal.readBuffer/
     *  sendText 가 이 터미널에 닿는다(코어 host-div 비의존). 터미널 플러그인이 마운트 시 자기
     *  TerminalInstance 의 readBuffer/sendInput 을 등록하고 언마운트 시 해지(반환 Disposable). */
    registerIo: (
      paneId: string,
      io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
    ) => Disposable;
    /** 생존 서비스 사이드카의 서비스 소켓에 NDJSON 요청/응답 1왕복 릴레이(웹뷰 JS 는 UDS 불가 —
     *  코어가 다리). 코어 내용 불가지: 요청/응답 JSON 통과 + 현재 창 label(라우팅 좌표)만 찍는다.
     *  연결 실패 = 명시 에러(사이드카 사망 loud 신호). */
    sidecarRequest: (req: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** 이 pane 의 봉인-블롭을 앱 볼트로 개봉해 평문(base64)을 돌려준다. 잠금=명시 에러
     *  (fail-closed), 블롭 없음=null. 코어는 바이트를 해석하지 않는다(소비자가 화면으로 해석).
     *  "terminal:read". */
    readSealedScreen: (
      paneId: string,
    ) => Promise<{ paintB64: string } | null>;
    /** 이 pane 에 라이브 데몬 세션이 있는가 — warm 복원 후보 판정(사이드카 무관, 즉답, 데몬 안
     *  띄움). 소비자가 스폰 전에 물어 warm(세션 존재)만 사이드카 복원 재개(부팅-레이스 유계 재시도)
     *  를 태운다 — 신선/cold/데몬 미가동(false)은 사이드카를 안 기다리고 즉시 진행한다. */
    paneAlive: (paneId: string) => Promise<boolean>;
  };
  /** 외부 서브프로세스 spawn + 양방향 raw stdio(범용 — LSP/MCP/ACP/임의 CLI 통합). "process" 권한.
   *  PTY 가 아니라 순수 파이프 → JSON-RPC 프레이밍 무손상. 이벤트 기반(폴링 0). */
  process?: {
    /** 매니페스트 sidecars[] 에서 이 계약(interface)을 구현한다고 선언한 유닛 이름. 어느 엔진 유닛을
     *  쓸지는 **매니페스트가 정한다** — 번들 상수로 굳히면 매니페스트만 바꿨을 때 옛 유닛이 무음으로
     *  스폰된다. 선언 부재/중복은 loud throw(조용히 고르지 않는다). */
    sidecarName: (interfaceRef: ContractRequirement) => string;
    /** 프로그램 spawn → handle(id). cwd/env 선택. envRemove=부모 env 에서 뗄 키(중첩 가드 제거 등).
     *  secretEnv=envVar→secretKey(이 플러그인 ns 의 시크릿). 평문은 JS 가 안 만진다 — 키 이름만 넘기면
     *  Rust 경계가 볼트에서 해소해 자식 env 에 주입(셸 args·ps·history 무노출 R2). 잠김/미존재면 spawn 실패.
     *  cmd "sidecar:{name}" = service 사이드카 이름 참조 — 코어가 identity 홈의 dist 진입점으로 해석
     *  (플러그인은 경로를 조립하지 않는다, A17/SIDECARS.md). 미설치면 spawn 전 명시 에러. */
    spawn: (
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
        /** setsid 로 스폰 — 부모(앱) 사망을 넘어 생존한다. "sidecar:{name}" 대상만 허용
         *  (detached_gate), kill_all 제외. 생존 서비스 사이드카를 스폰하는 열쇠. */
        detached?: boolean;
      },
    ) => Promise<number>;
    /** stdin 에 쓰기(JSON-RPC 프레임 등). */
    write: (handle: number, data: string) => Promise<void>;
    /** stdin 닫기(자식은 계속 실행) — 파이프 입력을 read-to-end 하는 자식에 EOF 전달. 멱등. */
    closeStdin: (handle: number) => Promise<void>;
    /** stdout 바이트 구독(반환=해지). 리스너 등록 전 도착분은 버퍼되어 유실 0. */
    onData: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** stderr 바이트 구독(반환=해지). */
    onStderr: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** 종료 코드 구독(반환=해지). 종료가 구독보다 먼저면 즉시 1회 호출. */
    onExit: (handle: number, cb: (code: number) => void) => Disposable;
    /** kill + 정리. */
    kill: (handle: number) => Promise<void>;
  };
  /** 사이드카(engine 모듈) 채널 — 매니페스트 sidecars[] 에 선언된 공유 네이티브 모듈을 앱 프로세스에
   *  로드하고 불투명 JSON 메시지를 주고받는다. "sidecar" 권한(caution). 코어는 맹목 relay(메시지
   *  의미는 플러그인↔사이드카 사적 계약 — docs/SIDECARS.md). 모듈은 로드 후 상주(unload 없음). */
  sidecar?: {
    /** 선언된 사이드카 열기 → 채널 핸들. 미선언 이름은 거부(선언≡실물). 최초 open 이 로드+검증+init. */
    open: (name: string) => Promise<SidecarHandle>;
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
   *  안 만진다 — Rust 경계가 볼트에서 해소해 url/headers/body 의 placeholder 에 치환(history/응답 무노출 R2).
   *  impersonate="chrome" 은 브라우저 핑거프린트(JA3/JA4) 백엔드로 보낸다(핑거프린트 차단 CDN 통과용);
   *  "off"(기본)은 평문 native-tls. Authorization 요청은 redirect 0이며 per-request redirect를 고정할 수
   *  없는 chrome 모드에서는 fail-closed한다. 응답 shape·시크릿·ns 격리는 모드와 무관하게 동일. */
  network?: {
    http: (req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      secretSubst?: Record<string, string>;
      impersonate?: "off" | "chrome";
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

// message 미제공(라벨 폴백)으로 등록된 플러그인 명령 전역 집합 — plugin.conformance 가 정확히
// 보고하는 게이트 소스(로드타임 거부 대신 발행/진단 경계에서 강제, MESSAGE-PROTOCOL §3).
export const commandsMissingMessage = new Set<string>();

export function isBlockedForPlugins(name: string): boolean {
  // registry.* 는 카탈로그 조회까지 descriptor/trust/credential metadata를 노출하는 운영자
  // control plane이다. 개별 이름 열거는 새 관리 명령이 추가될 때 기본 허용으로 새는 구조이므로
  // namespace 전체를 닫는다. 플러그인은 plugin.catalog로 설치 가능 unit만 읽는다.
  return (
    BLOCKED_MANAGEMENT.has(name) ||
    name.startsWith("plugin.dev.") ||
    name.startsWith("registry.") ||
    // Plugins already receive ownership-fixed app.secrets/app.network facades. Exposing the
    // operator commands as a second path would let commands.execute choose an arbitrary vault
    // namespace and turn net.http.request into a credential confused deputy.
    name.startsWith("secret.") ||
    name === "net.http.request"
  );
}

// 명령 이름에서 *대상 플러그인 id* 추출(cross-plugin 호출 판정용). pluginCommandName=plugin.<id>.<cmd>
// (id 에 dot 없음). null = cross-plugin 아님: 코어 명령(plugin. 접두 X)·plugin.view.*(호스트 뷰 ops)·
// plugin.dev.*·관리(plugin.list 등, 2세그). plugin.<id>.<cmd> 만 <id> 반환.
export function targetPluginId(name: string): string | null {
  if (!name.startsWith("plugin.")) return null;
  const rest = name.slice("plugin.".length);
  const dot = rest.indexOf(".");
  if (dot < 0) return null; // 관리(plugin.list 등) — isBlockedForPlugins 가 차단.
  const seg = rest.slice(0, dot);
  if (seg === "view" || seg === "dev") return null; // 뷰 ops / dev.
  return seg;
}

// cross-plugin 호출 인가 — caller 가 target 플러그인을 manifest.dependencies 에 선언했는지(직접 의존 presence).
// 자기 명령·코어·view 는 통과. 미선언 cross-plugin 이면 거부 사유 반환(없으면 null=허용). 호출경계 강제
// (§ dependencyGraph 선언이 install cascade·consent 표시에만 쓰이던 갭을 닫음). 버전은 install-time 소관.
// 호출 경계 — 다른 플러그인의 명령은 선언 없이 부를 수 없다. 선언은 두 축이고, 어느 쪽이든 통과한다:
//   L2 계약-핀(consumes): 호출자가 계약을 선언하고 대상이 그 계약을 implements 한다 → 통과. 호출자는
//     구현체 이름을 모른 채 부른다(구현체 무차별 — 다른 구현체로 갈아끼워도 매니페스트가 안 바뀐다).
//   L1 이름-핀(dependencies): 호출자가 대상 플러그인 id 를 직접 선언한다 → 통과. 신규 결합엔 금지고,
//     계약이 아직 없는 도메인의 과도기 결합만 이 축으로 남는다.
// 둘 다 없으면 거부 — 경계 자체는 그대로다. 바뀌는 것은 무엇을 선언하느냐다(이름 → 계약).
function crossPluginDenyReason(
  selfId: string,
  dependencies: Record<string, string> | undefined,
  commandName: string,
  consumes?: ContractRequirement[],
  implementsOf?: (pluginId: string) => ContractProviderRef[],
): string | null {
  const target = targetPluginId(commandName);
  if (target === null || target === selfId) return null;
  if (target in (dependencies ?? {})) return null;
  const wanted = consumes ?? [];
  if (wanted.length > 0 && implementsOf) {
    const provided = implementsOf(target);
    if (wanted.some((requirement) =>
      provided.some((provider) => contractRequirementSatisfiedBy(requirement, provider)))) return null;
  }
  return `미선언 의존 플러그인 호출: ${target} — manifest.consumes 에 그 계약 id 를(계약-핀), 또는 manifest.dependencies 에 "${target}" 을(이름-핀) 선언 필요 (명령: ${commandName})`;
}

// ── API 조립 ─────────────────────────────────────────────────────────────────

const denied = (message: string): CommandOutcome => ({
  ok: false,
  code: "PERMISSION_DENIED",
  message,
});

// app.process 구현 — handle(id)별 리스너 + 등록 전 도착분 버퍼(유실 0). spawn 시 Channel 3개
// (stdout/stderr/exit)를 만들어 process_spawn 에 넘기고, onData/onStderr/onExit 가 그 스트림을 구독.
function createProcessApi(
  deps: PluginApiDeps,
  tracker: DisposableTracker,
  ns: string,
  manifest: PluginManifest,
) {
  const declared = () => manifest.sidecars ?? [];
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
    // 매니페스트가 이 계약을 구현한다고 선언한 사이드카 유닛의 이름. 어느 엔진 유닛을 쓸지는
    // **매니페스트가 정한다** — 번들에 이름을 상수로 굳히면 매니페스트만 바꿨을 때 옛 유닛이 무음으로
    // 스폰된다(declared ≠ actual). 선언이 없거나 둘 이상이면 조용히 고르지 않고 loud 하게 죽는다.
    sidecarName(interfaceRef: ContractRequirement): string {
      const hits = declared().filter((sidecar) =>
        sidecar.interface.id === interfaceRef.id && sidecar.interface.range === interfaceRef.range);
      if (hits.length === 0) {
        throw new Error(
          `매니페스트 sidecars 에 ${interfaceRef.id} 요구를 가진 유닛 선언이 없다 — 선언이 유닛 선택의 단일진실이다`,
        );
      }
      if (hits.length > 1) {
        throw new Error(
          `매니페스트 sidecars 에 ${interfaceRef.id} 구현이 ${hits.length} 개다 — 계약당 유닛 하나만 선언한다`,
        );
      }
      return hits[0].name;
    },
    async spawn(
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
        // 부모(앱) 사망을 넘어 생존하는 새 세션 리더(setsid)로 스폰. "sidecar:{name}" 대상에만
        // 허용된다(detached_gate) — 생존 서비스 사이드카가 그 존재 이유다. kill_all 제외.
        detached?: boolean;
      },
    ): Promise<number> {
      // 선언≡실물 — app.sidecar(engine 모듈)가 지는 법을 service 사이드카 스폰도 진다. 매니페스트에
      // 없는 유닛을 스폰하면 매니페스트가 유닛 선택의 단일진실이라는 계약이 거짓말이 된다.
      const unit = cmd.startsWith("sidecar:") ? cmd.slice("sidecar:".length) : null;
      if (unit !== null && !declared().some((s) => s.name === unit)) {
        throw new Error(`매니페스트 sidecars 에 선언되지 않은 사이드카 스폰: ${unit}`);
      }
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
        detached: opts?.detached ?? null,
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
    closeStdin: async (handle: number): Promise<void> => {
      await deps.invoke("process_stdin_close", { id: handle });
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

// app.sidecar 채널 핸들 — 열린 engine 모듈과의 불투명 JSON 채널. 의미는 플러그인↔사이드카 사적
// 계약(docs/SIDECARS.md), 코어·이 API 는 내용을 해석하지 않는다.
export interface SidecarHandle {
  /** 불투명 요청 → 모듈의 동기 응답(JSON). */
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** 모듈 이벤트 구독 — 이벤트는 {event, ...payload} 형이고 event 필드로 demux. 반환=해지. */
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => Disposable;
  /** 채널 해제(모듈은 상주 유지 — unload 없음). 멱등. */
  close: () => Promise<void>;
}

// app.sidecar 구현 — 매니페스트 sidecars[] 에 선언된 engine 모듈만 연다(선언≡실물: 미선언 open =
// throw). 이벤트는 Tauri Channel 로 이 호출자에만 배달(전역 emit 아님 — 미개봉 코드 무배달·누수 0).
function createSidecarApi(
  deps: PluginApiDeps,
  tracker: DisposableTracker,
  manifest: PluginManifest,
) {
  return {
    open: async (name: string): Promise<SidecarHandle> => {
      const decl = (manifest.sidecars ?? []).find((s) => s.name === name);
      if (!decl) {
        throw new Error(`매니페스트 sidecars 에 선언되지 않은 사이드카: ${name}`);
      }
      const listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();
      const onEvent = new Channel<Record<string, unknown>>();
      onEvent.onmessage = (m) => {
        const ev = typeof m?.event === "string" ? (m.event as string) : "";
        listeners.get(ev)?.forEach((f) => f(m));
      };
      const handle = (await deps.invoke("sidecar_open", {
        name,
        requirement: decl.interface,
        onEvent,
      })) as number;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await deps.invoke("sidecar_close", { name, handle }).catch(() => {});
      };
      tracker.wrap(() => void close()); // 플러그인 비활성화 시 채널 회수
      return {
        send: async (msg) =>
          (await deps.invoke("sidecar_send", {
            name,
            handle,
            payload: JSON.stringify(msg),
          })) as Record<string, unknown>,
        on: (event, cb) => {
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(cb);
          return tracker.wrap(() => void listeners.get(event)?.delete(cb));
        },
        close,
      };
    },
  };
}

// app.pty 구현 — PTY 세션 spawn + raw 바이트 IO(터미널 플러그인이 xterm 구동). 네이티브 명령은 기존
// spawn/write/resize/ack/close_terminal(명령명 유지). 출력은 Channel 스트림(createProcessApi 와 동형 —
// onData 등록 전 도착분 버퍼로 유실 0). SOKSAK_* env 주입·flow control 커널 측은 pty.rs 가 소유.
function createPtyApi(deps: PluginApiDeps, tracker: DisposableTracker) {
  type Bytes = (d: Uint8Array) => void;
  interface PtyState {
    out: Set<Bytes>;
    outBuf: Uint8Array[];
    // 이 PTY 를 substrate 관찰에 연결한 paneId(있으면 close 시 관찰도 회수). 없으면 undefined.
    paneId?: string;
  }
  const ptys = new Map<number, PtyState>();
  return {
    spawn: async (opts: {
      cols: number;
      rows: number;
      cwd?: string;
      shell?: string;
      paneId?: string;
      replay?: "none" | { fromSeq: number };
    }): Promise<number> => {
      const paneId = opts.paneId;
      // [substrate 관찰 탭] paneId 가 있으면 이 PTY 의 출력을 관찰 파서에 흘려, app.terminal.*
      // (getCwd/onCwd/onCommandFinished)·command.*/turn.ended 가 이 플러그인 터미널에도 자동으로
      // 동작하게 한다. 코어 터미널 뷰가 자기 OSC 를 파싱하던 것과 무관 — 같은 paneId 는 한
      // producer 만 채우므로 이중 발화가 없다(ptyObservationStore 단일 producer 불변식).
      if (paneId) registerPtyObservation(paneId);
      const st: PtyState = { out: new Set(), outBuf: [], paneId };
      const onOutput = new Channel<ArrayBuffer>();
      onOutput.onmessage = (m) => {
        const b = new Uint8Array(m);
        if (paneId) feedPtyOutput(paneId, b); // 관찰: onData 구독과 독립(누가 구독하든 자동).
        if (st.out.size) st.out.forEach((f) => f(b));
        else st.outBuf.push(b);
      };
      // windowLabel 은 코어가 현재 창으로 주입(멀티윈도우 sok 타겟 — webviewLabels 단일진실).
      // replay = 소비자의 화면 복원 제어(배관, 내용 불가지): "none" = 소비자가 화면을 소유(코어
      // 복원 없음), {fromSeq} = raw 링을 그 seq 부터 부착(레이스-프리 warm 핸드오프 — 소비자가 이미
      // 그 seq 까지 그렸다). 부재는 코어가 "none" 동치로 방어 해석(legacy 코어-소유 재생은 방출됨).
      const res = (await deps.invoke("spawn_terminal", {
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? null,
        shell: opts.shell ?? null,
        paneId: paneId ?? null,
        windowLabel: currentWindowLabel() || null,
        replay: opts.replay ?? null,
        onOutput,
      })) as { id: number };
      ptys.set(res.id, st);
      return res.id;
    },
    write: (id: number, data: string): Promise<void> =>
      deps.invoke("write_terminal", { id, data }) as Promise<void>,
    resize: (id: number, cols: number, rows: number): Promise<void> =>
      deps.invoke("resize_terminal", { id, cols, rows }) as Promise<void>,
    ack: (id: number, bytes: number): Promise<void> =>
      deps.invoke("ack_terminal", { id, bytes }) as Promise<void>,
    close: (id: number): Promise<void> => {
      const st = ptys.get(id);
      if (st?.paneId) disposePtyObservation(st.paneId); // substrate 관찰 회수.
      ptys.delete(id);
      return deps.invoke("close_terminal", { id }) as Promise<void>;
    },
    onData: (id: number, cb: Bytes): Disposable => {
      const st = ptys.get(id);
      if (!st) return tracker.wrap(() => {});
      st.out.add(cb);
      for (const b of st.outBuf.splice(0)) cb(b); // 등록 전 버퍼 즉시 재생(유실 0)
      return tracker.wrap(() => st.out.delete(cb));
    },
    which: (bin: string): Promise<string | null> =>
      deps.invoke("shell_which", { bin }) as Promise<string | null>,
    // PTY IO 핸들러 등록(substrate) — app.terminal.readBuffer/sendText 의 우선 경로. tracker 로
    // 비활성화 시 자동 해지(누수 0). 플러그인 언마운트가 직접 dispose 해도 멱등(같은 io 만 해지).
    registerIo: (
      paneId: string,
      io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
    ): Disposable => tracker.wrap(registerPtyIo(paneId, io)),
    // 생존 서비스 사이드카의 서비스 소켓에 NDJSON 요청/응답 1왕복을 릴레이한다(웹뷰 JS 는 UDS 를
    // 못 열어 코어가 다리를 놓는다 — 데몬 바이트 다리 pty.rs 와 같은 층위). 코어는 내용 불가지:
    // 요청/응답 JSON 을 그대로 통과시키고 현재 창 label(라우팅 좌표 — spawn 과 동일)만 찍는다.
    // 연결 실패는 명시 에러(무음·행 아님) — 사이드카 사망의 loud 신호. "pty" 권한.
    sidecarRequest: (req: Record<string, unknown>): Promise<Record<string, unknown>> =>
      deps.invoke("pty_sidecar_request", {
        request: { ...req, window: currentWindowLabel() || null },
      }) as Promise<Record<string, unknown>>,
    // 이 pane 의 봉인-블롭을 읽어 앱 볼트로 개봉한 평문을 돌려준다(base64). 잠금이면 명시 에러
    // (fail-closed — 평문 우회 없음), 블롭 없으면 null. 소비자가 바이트를 화면으로 해석해 죽은
    // 세션 화면을 다시 그린다(사이드카 불요 경로). 코어는 바이트를 해석하지 않는다. "terminal:read".
    readSealedScreen: (
      paneId: string,
    ): Promise<{ paintB64: string } | null> =>
      deps.invoke("pty_read_sealed_screen", {
        windowLabel: currentWindowLabel() || null,
        paneId,
      }) as Promise<{ paintB64: string } | null>,
    paneAlive: (paneId: string): Promise<boolean> =>
      deps.invoke("pty_pane_alive", { paneId }) as Promise<boolean>,
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

// app.network 구현 — http(req) → 코어 net_http_request 위임. ns=플러그인 id 주입(타 ns 시크릿
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
      impersonate?: "off" | "chrome";
    }): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      return (await deps.invoke("net_http_request", {
        method: req.method,
        url: req.url,
        headers: req.headers ?? null,
        query: req.query ?? null,
        body: req.body ?? null,
        contentType: req.contentType ?? null,
        ns,
        secretSubst: req.secretSubst ?? null,
        impersonate: req.impersonate ?? null,
      })) as { status: number; headers: Record<string, string>; body: string };
    },
  };
}

export function buildPluginApi(
  manifest: PluginManifest,
  _dir: string,
  deps: PluginApiDeps,
): {
  api: SoksakPluginApi;
  tracker: DisposableTracker;
  registered: {
    commands: Set<string>;
    views: Set<string>;
    fileViewers: Set<string>;
    iconSets: Set<string>;
  };
} {
  const tracker = new DisposableTracker();
  // [conformance] 실제 등록된 contribution id 추적 — activate 후 declared≡actual inventory 용.
  const registered = {
    commands: new Set<string>(),
    views: new Set<string>(),
    fileViewers: new Set<string>(),
    iconSets: new Set<string>(),
  };
  const id = manifest.id;
  const has = (p: PluginPermission) => manifest.permissions.includes(p);

  // 플러그인 호출 컨텍스트: 원격 아님(권한은 이 API 게이트가 담당 — §0-2 문서화된 모델).
  const pluginCtx: CommandContext = {};

  const executeGated = async (
    name: string,
    params?: Record<string, unknown>,
    // 유래·상관 운반(§5) — 중첩 실행의 상속(inv) 또는 자동 행위의 자기 선언(opts.origin).
    // 게이트는 동일하게 탄다.
    inherit?: { origin?: string; parent?: string },
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
    // cross-plugin 호출은 의존 선언 필수 — 미선언이면 거부(호출경계 강제). 코어/자기/view 는 통과.
    const crossDeny = crossPluginDenyReason(
      id,
      manifest.dependencies,
      name,
      manifest.consumes,
      deps.implementsOf,
    );
    if (crossDeny) {
      return denied(crossDeny);
    }
    return deps.execute(name, params ?? {}, {
      ...pluginCtx,
      ...(inherit?.origin !== undefined ? { origin: inherit.origin } : {}),
      ...(inherit?.parent !== undefined ? { parent: inherit.parent } : {}),
    });
  };

  const api: SoksakPluginApi = {
    appVersion: deps.appVersion,
    pluginId: id,
    locale: () => useSettings.getState().language,
    windowLabel: () => currentWindowLabel() || "main",

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
      progress: (command, delta) => {
        emitPluginEvent("command.progress", { command, delta, source: id });
      },
    },

    activity: {
      // 자기기술 발행 — 플러그인이 자기 활동 엔트리를 코어 브리지 없이 허브에 싣는다. source=id 고정
      // (자기 이름표만), payload 는 verbatim 저장(허브 schema-agnostic). events.progress 와 같은 급(무권한).
      publish: (kind, entry) => {
        void deps.invoke("activity_publish", {
          kind,
          source: id,
          payload: { ...entry, window: currentWindowLabel() },
        });
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
            const declared = gateContribution({
              contributesKey: "commands",
              noun: "명령",
              id: name,
              declared: manifest.contributes.commands,
              idOf: (c) => c.name,
            });
            registered.commands.add(name);
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
            // 응답 봉투 표준(MESSAGE-PROTOCOL): message 는 명령이 제공한다. summarize 는 message 의
            // 구명(전환기 호환 — M5 sweep 에서 제거). 둘 다 없으면 답을 라벨로 대신하고 경고하며,
            // plugin.conformance 가 그 명령을 messagesMissing 으로 보고한다(정확한 저자 게이트 —
            // 로드타임 거부는 message 회귀 시 플러그인을 벽돌로 만들어, 게이트 경계는 발행/진단이다).
            const pluginAnswer = spec.message ?? spec.summarize;
            const full = pluginCommandName(id, name);
            if (typeof pluginAnswer !== "function") {
              console.warn(
                `[plugin:${id}] 명령 '${name}' 에 message 미제공 — 답이 라벨로 열화(MESSAGE-PROTOCOL §3)`,
              );
              commandsMissingMessage.add(full);
            } else {
              commandsMissingMessage.delete(full);
            }
            const labelAnswer = () =>
              declared.title ? localize(declared.title) : name;
            deps.registerCommand(full, {
              description: spec.description,
              title: declared.title, // 사람 라벨(ko/en) — 매니페스트가 소유, 표시 표면이 해소
              triggers: spec.triggers, // 호스트 catalogJson 이 base+triggers 합성(docs/I18N.md §3)
              params: spec.params ?? {},
              returns: spec.returns ?? "object",
              examples: spec.examples,
              message: pluginAnswer ?? labelAnswer, // 표준 답변 — 없으면 라벨(전환 스캐폴드, 경고)
              speak: spec.speak, // 낭독 문장(§3) — 낭독 축의 전부(없으면 침묵 — opt-in)
              // hint(가능성의 제시) — handler 와 같은 컨텍스트 변환으로 흘린다. 상한·예외
              // 안전은 execute 소유(응답을 깨지 않는다).
              hint: spec.hint
                ? (data, ctx) =>
                    spec.hint!(data, {
                      origin: ctx?.origin,
                      parent: ctx?.parent,
                      execute: (n, p) =>
                        executeGated(n, p, { origin: ctx?.origin, parent: ctx?.parent }),
                    })
                : undefined,
              trace: spec.trace, // 계측 스펙(§4) — false=관찰 부산물 명령의 기록 제외
              danger, // 매니페스트 권위(없으면 런타임 fallback — 게이트 보존)
              // registry.execute 가 try/catch 로 INTERNAL 변환(§0-4).
              // inv = 호출 컨텍스트 상속 통로(§5): 핸들러의 중첩 실행이 부모의 유래(origin)와
              // 상관(parent)을 계승한다 — 스케줄 발화의 자식이 사람으로 위장되지 않는다.
              // 게이트(권한·cross-plugin)는 executeGated 그대로(우회 없음).
              handler: (params, ctx) =>
                spec.handler(params, {
                  origin: ctx?.origin,
                  parent: ctx?.parent,
                  execute: (n, p) =>
                    executeGated(n, p, { origin: ctx?.origin, parent: ctx?.parent }),
                }),
            });
            return tracker.wrap(() => deps.unregisterCommand(full));
          },
        }
      : undefined,

    // programs 기여는 완전 선언형 — loader 가 자동 등록(명령형 API 없음 §2.6).

    ui: has("ui") || has("ui:statusbar") || has("ui:titlebar") || has("ui:overlay:screen") || has("ui:overlay:pane")
      ? {
          registerView: (viewId, provider) => {
            const decl = gateContribution({
              contributesKey: "views",
              noun: "뷰",
              id: viewId,
              declared: manifest.contributes.views,
              idOf: (v) => v.id,
            });
            registered.views.add(viewId);
            const remove = useViewRegistry
              .getState()
              .register(id, decl, provider);
            return tracker.wrap(remove);
          },
          registerFileViewer: (viewerId, provider) => {
            const decl = gateContribution({
              contributesKey: "fileViewers",
              noun: "파일 뷰어",
              id: viewerId,
              declared: manifest.contributes.fileViewers,
              idOf: (f) => f.id,
            });
            registered.fileViewers.add(viewerId);
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
            const decl = gateContribution({
              contributesKey: "iconSets",
              noun: "셋",
              id: setId,
              declared: manifest.contributes.iconSets,
              idOf: (s) => s.id,
            });
            registered.iconSets.add(setId);
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
          // 오버레이 입력 게이트(useUi overlayCount → webview_overlay_active). 콘텐츠 네이티브
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
            // kv 변경(coll 없음)만 — 이 플러그인 ns 의 set/delete 전 창 broadcast 를 필터(폴링 0).
            watch: (cb) => {
              const un = deps.onDataChange((e) => {
                if (e.ns === id && e.coll == null) cb(e.id);
              });
              return tracker.wrap(un);
            },
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
          // retention(R5) — count FIFO trim / TTL reaper. 반환=삭제 수. 터미널 블록 등 영속 컬렉션이 호출.
          retentionTrim: (collection, scope, cap) =>
            deps.invoke("data_retention_trim", {
              ns: id,
              coll: collection,
              scope,
              cap,
            }) as Promise<number>,
          retentionReap: (collection, cutoffMs) =>
            deps.invoke("data_retention_reap", {
              ns: id,
              coll: collection,
              cutoff_ms: cutoffMs,
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

    // 범용 스케줄러 — 코어 ScheduleState(단일 진실)로 forward(매핑 없는 얇은 통로, app.data 선례).
    // register 의 command 는 발화 시 registry 로 라우팅된다. reconcile 작업은 poke 로 상태-틱을 돌린다.
    scheduler: has("schedule")
      ? {
          register: (job) => {
            // 예약 실행도 플러그인이 만든 호출이다. 직접 commands.execute와 같은 관리 경계를
            // 등록 시점에 적용하지 않으면 schedule이 시간차 권한 우회 통로가 된다.
            if (isBlockedForPlugins(job.command)) {
              return Promise.reject(
                new Error(`플러그인은 관리 명령을 예약할 수 없음(§0-5): ${job.command}`),
              );
            }
            // 스케줄 발화는 코어 remote 채널이라 executeGated 를 안 거친다 → cross-plugin 강제를
            // 우회할 수 있다(A 가 plugin.B.cmd 를 스케줄). 등록 시점(caller 식별 가능)에 동형 검사.
            const crossDeny = crossPluginDenyReason(
              id,
              manifest.dependencies,
              job.command,
              manifest.consumes,
              deps.implementsOf,
            );
            if (crossDeny) {
              return Promise.reject(new Error(crossDeny));
            }
            const p = deps.invoke("schedule_register", {
              trigger: job.trigger,
              command: job.command,
              params: job.params ?? null,
              id: job.id ?? null,
              retry: job.retry ?? null,
              concurrency: job.concurrency ?? null,
              timeout_ms: job.timeout_ms ?? null,
              process_lease: job.process_lease ?? null,
              // process_lease 시 backstop 미지정이면 3h 기본 주입. null=무한(코어 None). 그래서 코어
              // None 은 "무한" 의미만 갖는다(JS 가 기본을 책임짐). 비-프로세스면 무시되므로 null.
              zombie_backstop_ms: job.process_lease
                ? job.zombie_backstop_ms === undefined
                  ? 10_800_000
                  : job.zombie_backstop_ms
                : null,
              // 소유자 스탬프(B2) — 코어는 owner 있는 잡을 persist 하지 않는다(플러그인이 activate 에서
              // 재장전). 그래서 부팅 재장전은 코어 잡만 → 비활성 플러그인 잡의 orphan 발화 0.
              owner: id,
            }) as Promise<string>;
            // 생명주기 결속(B1) — 명령 등록(위)과 동일하게 deactivate 시 tracker 가 잡을 취소한다.
            // 스케줄이 소유자(플러그인)보다 오래 사는 규칙 구멍을 닫는다(저자가 잊어도 안전).
            tracker.wrap(() => {
              void p.then((jid) => deps.invoke("schedule_cancel", { id: jid })).catch(() => {});
            });
            return p;
          },
          poke: async (jobId) => {
            await deps.invoke("schedule_poke", { id: jobId ?? null });
          },
          cancel: (jobId) =>
            deps.invoke("schedule_cancel", { id: jobId }) as Promise<boolean>,
          list: () =>
            deps.invoke("schedule_list") as Promise<SchedulerJobView[]>,
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
            // [RULE] 로컬 파일 → webview 가 직접 로드 가능한 URL. 코어 표준 — 파일을 읽어 띄우는 모든
            // 플러그인(에디터·미디어·이미지뷰어)이 동일 경로로 쓴다. asset:// 프로토콜은 hidden 디렉터리
            // (.soksak)를 scope 에서 막는다 → read_file_base64(에디터가 쓰는 검증된 경로) 위에 blob URL.
            // 멱등: 같은 path → 같은 URL(재read·재생성 없음). 언로드 시 revoke. "fs:read" 게이트 공유.
            url: has("fs:read")
              ? (() => {
                  const urlCache = new Map<string, string>();
                  return async (path: string): Promise<string> => {
                    const hit = urlCache.get(path);
                    if (hit) return hit;
                    const { mime, base64 } = (await deps.invoke("read_file_base64", {
                      path,
                    })) as { mime: string; base64: string };
                    const bin = atob(base64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
                    urlCache.set(path, objectUrl);
                    tracker.wrap(() => {
                      URL.revokeObjectURL(objectUrl);
                      urlCache.delete(path);
                    });
                    return objectUrl;
                  };
                })()
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
                  // 등록된 PTY IO(substrate) 로 화면 읽기 — 플러그인 터미널이 registerIo 로 등록한 키.
                  readBuffer: (paneId: string, lines?: number) =>
                    getPtyIo(paneId)?.readBuffer(lines),
                  onOutput: (paneId: string, cb: () => void) =>
                    tracker.wrap(subscribeOutput(paneId, cb)),
                }
              : {}),
            ...(has("terminal:write")
              ? {
                  // sendText: substrate IO(플러그인 터미널 registerIo). 없으면 false(미준비).
                  sendText: (paneId: string, text: string) => {
                    const io = getPtyIo(paneId);
                    if (io) {
                      io.sendInput(text);
                      return true;
                    }
                    return false;
                  },
                }
              : {}),
          }
        : undefined,
    // 코어가 소유하는 child webview 구동(브라우저 플러그인). 네이티브 명령 = webview_*(capability 접두,
    // docs/NAMING.md 법). label 은 webviewLabels 단일진실에서만 파생.
    webview: has("webview")
      ? {
          label: (viewId: string) => browserLabel(viewId),
          open: (label, o) =>
            deps.invoke("webview_open", { label, ...o }) as Promise<void>,
          bounds: (label, x, y, w, h) =>
            deps.invoke("webview_bounds", { label, x, y, w, h }) as Promise<void>,
          visible: (label, visible) =>
            deps.invoke("webview_visible", { label, visible }) as Promise<void>,
          navigate: (label, url) =>
            deps.invoke("webview_navigate", { label, url }) as Promise<void>,
          openWindow: (url) =>
            deps.invoke("webview_open_window", { url }) as Promise<void>,
          history: (label, delta) =>
            deps.invoke("webview_history", { label, delta }) as Promise<void>,
          stop: (label) =>
            deps.invoke("webview_stop", { label }) as Promise<void>,
          devtools: (label) =>
            deps.invoke("webview_devtools", { label }) as Promise<boolean>,
          eval: (label, js) =>
            deps.invoke("webview_eval", { label, js }) as Promise<string>,
          injectScript: (label, code, phase) => {
            void deps.invoke("webview_inject_script", {
              label,
              code,
              phase: phase ?? "document-start",
            });
            return tracker.wrap(() => {}); // WKUserScript 개별 제거 미지원(webview 수명까지)
          },
          on: (label, event, cb) =>
            tracker.wrap(deps.subscribeWebview(label, event, cb)),
          list: async (prefix) => {
            const all = (await deps.invoke("webview_list", {})) as string[];
            return prefix ? all.filter((l) => l.startsWith(prefix)) : all;
          },
          close: (label) =>
            deps.invoke("webview_close", { label }) as Promise<void>,
          // 창 합성 캡처를 rect(CSS px, 창 좌표 — getBoundingClientRect 공간)로 crop 한
          // PNG data URL. 가림 상태에서도 캡처. 용도: 드래그 중 네이티브 표면의 시각 연속
          // 스탠드인(freeze-frame — layout.resize-gesture 와 짝).
          captureRegion: async (rect) => {
            const b64 = (await deps.invoke("plugin:webview-capture|snapshot_region", {
              x: rect.x,
              y: rect.y,
              w: rect.w,
              h: rect.h,
            })) as string;
            return `data:image/png;base64,${b64}`;
          },
        }
      : undefined,
    pty: has("pty") ? createPtyApi(deps, tracker) : undefined,
    process: has("process") ? createProcessApi(deps, tracker, id, manifest) : undefined,
    sidecar: has("sidecar") ? createSidecarApi(deps, tracker, manifest) : undefined,
    network: has("network") ? createNetworkApi(deps, id) : undefined,
    ws: has("network") ? createWsApi(deps, tracker) : undefined,
    bus: {
      emit: (topic: string, payload: unknown) => busEmit(topic, payload),
      on: (topic: string, fn: (payload: unknown) => void) =>
        tracker.wrap(busOn(topic, fn)),
    },
  };

  return { api, tracker, registered };
}
