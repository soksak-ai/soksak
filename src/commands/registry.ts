// Command Registry — soksak 전 기능의 단일 진실.
// 모든 기능은 여기 등록된 command 하나로 표현되고, CLI(sok)/MCP/UI 는 호출자일 뿐이다.
// 문서(sok help/docs)와 MCP tool 정의도 이 스펙에서 생성된다 — 코드와 어긋날 수 없다.

import type { CmdErrCode } from "../state/sessions";
import type { LocalizedText } from "../plugins/spec";
import { currentWindowLabel } from "../lib/webviewLabels";
import { tmsg } from "../i18n";

// 파라미터 스펙(JSON 직렬화 가능 — CLI/MCP/문서 생성에 그대로 쓰임).
export interface ParamSpec {
  // json = 임의 JSON 값(핸들러가 직접 검증).
  type: "string" | "number" | "boolean" | "string[]" | "number[]" | "json";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  default?: unknown;
}

// 명령 hint(제시) — 실행 결과에 곁들이는 후속 명령 후보. cmd=제안하는 명령줄, why=왜 유용한지 한 줄.
// [철학] hint 는 지시가 아니라 가능성의 제시다 — "이런 것이 가능하다"를 알려 받은 쪽(사람·AI)의
// 판단을 돕는다. 강제가 아니다: 받은 쪽이 무시해도, 다른 수를 둬도 된다.
export interface CommandHint {
  cmd: string;
  why: string;
}

export interface CommandSpec {
  // description = 영어 base(역할·무엇·언제·왜). LLM 발견 표면 — stub(이름 복붙) 금지. 사람 UI 아님.
  description: string;
  // triggers = 비영어 언어별 트리거 단어(공백구분). 노출 시 composeTriggers 로 base 에 합성된다.
  // 영어 매칭은 base prose 가 담당하므로 en 은 보통 생략. 언어 추가(ja/zh)=이 맵에 키만 추가(docs/I18N.md §3).
  triggers?: Record<string, string>;
  params: Record<string, ParamSpec>;
  // 사람이 읽는 명령 라벨(아나운서체 — "git 저장소를 초기화합니다"). 표시 표면(피드 버블 등)이
  // raw 키 대신 이걸 현재 언어로 해소해 보인다. 플러그인 명령은 매니페스트 contributes.commands
  // 의 title 이 실린다(플러그인 소유). 라벨의 단일 진실은 명령 정의 자신 — 별도 표 금지.
  title?: LocalizedText;
  // 성공 응답 형태 설명(매뉴얼용).
  returns: string;
  // 표준 답변(message, 표시) — 성공 결과 data 를 사람이 읽는 한 줄로. **필수**: 모든 명령은 자기
  // 답을 안다. 추측 계층(형태 파생)·code 에코 폴백은 없다. 문장은 tmsg(키 테이블) 로 현재 언어
  // 해소된 문자열이다(P0 — 언어 추가 = 테이블 열 추가). docs/MESSAGE-PROTOCOL.md 응답 봉투 계약.
  message: (data: Record<string, unknown>) => string;
  // 낭독 문장(speak, 낭독) — message(표시)와 대칭 seam. 낭독 축은 이것 하나다(§3): speak 있으면 성공·실패
  // 불문 speak(outcome)가 문장, 없으면 message 폴백, "" = 침묵. 낭독 수행 명령(say 류)은
  // speak: () => "" 로 되먹임을 끊는다. 문장은 message 와 같은 결로 tmsg 로 짓는다(P0).
  speak?: (out: CommandOutcome) => string;
  // 성공 hint(제시) — 이 명령이 통했을 때 받은 쪽이 다음에 둘 만한 수를 제시한다(최대 3, execute 가
  // 자른다). message/speak 와 같은 결의 자기서술 필드: 명령은 자기 후속을 안다. 응답 페이로드(data)와
  // 호출 ctx 를 받아 CommandHint[] 를 짓는다. [철학] 지시가 아니라 가능성의 제시 — 받은 쪽의 판단을
  // 돕는다. 던지면 execute 가 응답을 깨지 않고 hint 만 생략한다.
  hint?: (data: Record<string, unknown>, ctx: CommandContext) => CommandHint[];
  // 발생 가능한 에러 코드.
  errors?: readonly (CmdErrCode | "INTERNAL" | "TIMEOUT")[];
  // CLI 사용 예시(매뉴얼용).
  examples?: readonly string[];
  // 위험 분류(원격/AI 호출 권한 게이트 대상): destructive=닫기·제거, inject=입력 주입.
  danger?: "destructive" | "inject";
  // 실행 계측 선언 — false 면 이 명령의 실행이 활동 트레이스(command.executed)에서 제외된다.
  // §5 R2: 유일한 정당 사유는 "동일 사실의 이중 기록 방지"(orchestrator.ask — chat.prompt/
  // answer 가 그 턴의 대표 기록)뿐이다. 소음 억제 목적의 선언 금지 — 그건 origin(노출 축) 몫.
  trace?: false;
  // [RULE] 핸들러 반환 객체에 top-level "id" 를 쓰지 말 것 — 소켓 응답이 JSON-RPC 봉투의
  // 요청 id(숫자)와 한 객체로 합쳐져 덮어쓴다(식별자 유실). 식별자는 네임스페이스 필드로
  // (groupId/viewId/messageId/label …). 같은 이유로 "ok"/"code"/"message" 도 결과 의미로만 사용.
  handler: (
    params: Record<string, unknown>,
    ctx: CommandContext,
  ) => Promise<object> | object;
}

// 호출자 컨텍스트: 터미널에서 호출하면 그 pane(PTY env SOKSAK_PANE → 소켓 요청 메타).
// remote=소켓 경유(AI/CLI) — 권한 게이트는 remote 호출에만 적용(UI 는 사람).
export interface CommandContext {
  pane?: string;
  remote?: boolean;
  // 멀티 윈도우: 이 명령이 도착한 창 label(소켓 emit_to 타겟). 창 명령(window.*)·라우팅 확인용.
  window?: { label: string };
  // 상관 부모(대화 턴 id) — 에이전트 env SOKSAK_PARENT → sok 요청 meta 로 도착. trace 의
  // parentId 가 되어 이 실행을 그 턴의 활동 세트로 묶는다(docs/MESSAGE-PROTOCOL.md).
  parent?: string;
  // 실행 유래(§5) — 생략=사람 유래(콘솔·터미널·에이전트 턴). "schedule" 등 시스템 유래는
  // 낭독 후보에서 제외되고(아래 execute) 피드에서 흐리게 표시된다.
  origin?: string;
}

// 권한 게이트 콜백(설정 store 를 registry 가 직접 알지 않게 주입).
// danger 분류에 대해 허용 여부를 돌려준다.
let permissionGate: (danger: "destructive" | "inject") => boolean = () => true;

export function setPermissionGate(
  fn: (danger: "destructive" | "inject") => boolean,
): void {
  permissionGate = fn;
}

// 표준 응답 봉투(요청·진행·응답 3부의 응답) — 성공/실패 대칭. docs/MESSAGE-PROTOCOL.md 단일진실.
//   ok      성공/실패
//   code    성공: "OK"/도메인(CREATED·NOOP·UNCHANGED…), 실패: ErrCode 닫힌 열거형
//   message 사람이 읽는 한 줄 표준 답변(성공·실패 모두 — 버블이 이걸 렌더). 명령이 제공(spec.message).
//   data    기계 페이로드(선택, 중첩 — 봉투 예약키와 충돌 원천 제거)
export type ErrCode =
  | CmdErrCode
  | "INTERNAL"
  | "TIMEOUT"
  | "UNKNOWN_COMMAND"
  | "INVALID_PARAMS"
  | "PERMISSION_DENIED";
// 표시 미디어(선택) — 이미지 등 "그대로 렌더할 내용"을 응답이 스스로 선언한다(MCP content 정합).
// 소비자(피드·폰·미래 표면)는 키 냄새 맡기 없이 media 만 보고 렌더한다. base64 또는 path 중 하나.
export interface MediaContent {
  kind: string; // "image/png" 등 MIME
  base64?: string;
  path?: string;
}

export interface CommandOutcome {
  ok: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  media?: MediaContent;
  // 이 응답이 도착·조립된 창 label(멀티 윈도우 상관·라우팅). execute 가 모든 경로(성공·실패)에 얹는다.
  window?: string;
  // 후속 명령 후보(제시) — 성공 시 spec.hint, 실패 시 오류 코드별 표준 안내. 최대 3개.
  hint?: CommandHint[];
}
// 하위호환 별칭 — 실패 봉투를 지칭하던 기존 참조 유지.
export type CommandError = CommandOutcome & { ok: false };

const registry = new Map<string, CommandSpec>();

export function register(name: string, spec: CommandSpec): void {
  registry.set(name, spec);
}

// 등록 해제 — 플러그인 생명주기(비활성화/제거) 전용. 존재했으면 true.
export function unregister(name: string): boolean {
  return registry.delete(name);
}

export function getSpec(name: string): CommandSpec | undefined {
  return registry.get(name);
}

// LLM 발견 표면 합성(docs/I18N.md §3, 결정 8). 영어 base + 전 언어 트리거어를 한 문자열로.
// 로케일 사본이 아니라 단일 합성 — MCP 에 로케일 채널이 없는 한계를 우회하고, 언어가 늘어도(triggers
// 데이터만 추가) 자동 확장. 사람 UI 는 이걸 쓰지 않는다(그쪽은 LocalizedText 해소).
//  - 언어 순서 = 언어코드 알파벳 오름차순(결정적·대화언어 무관). 라벨 없음(스크립트로 자기식별).
//  - 각 언어 문자열 내 공백토큰 중복 제거(케이스무시). 빈 언어·빈 triggers → 무시(빈값이면 base 그대로).
export function composeTriggers(base: string, triggers?: Record<string, string>): string {
  if (!triggers) return base;
  const groups = Object.keys(triggers)
    .sort()
    .map((lang) => dedupTokens(triggers[lang]))
    .filter((s) => s.length > 0);
  return groups.length ? `${base} | ${groups.join(" | ")}` : base;
}

// 공백구분 토큰에서 중복 제거(케이스무시, 첫 등장 순서·표기 유지).
function dedupTokens(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of (s ?? "").trim().split(/\s+/)) {
    if (!tok) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out.join(" ");
}

// 카탈로그(핸들러 제외, 직렬화 가능) — sok commands/help/docs/MCP tool 목록의 원천.
// description = composeTriggers(base, triggers) — CLI/MCP/skill 이 보는 단일 합성본.
export function catalogJson(): {
  name: string;
  description: string;
  params: Record<string, Omit<ParamSpec, never>>;
  returns: string;
  errors: readonly string[];
  examples: readonly string[];
  danger?: "destructive" | "inject";
}[] {
  return [...registry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => ({
      name,
      description: composeTriggers(s.description, s.triggers),
      params: s.params,
      returns: s.returns,
      errors: s.errors ?? [],
      examples: s.examples ?? [],
      // 위험 분류는 선언된 스펙에만 싣는다(권한 게이트 표면이 카탈로그에서 danger 를 읽는다).
      ...(s.danger ? { danger: s.danger } : {}),
    }));
}

// 파라미터 검증: 필수/타입/enum. 선언 안 된 키는 거부(오타 조기 발견).
function validate(
  spec: CommandSpec,
  params: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(params)) {
    if (!(key in spec.params)) return `알 수 없는 파라미터: ${key}`;
  }
  for (const [key, p] of Object.entries(spec.params)) {
    const v = params[key];
    if (v === undefined || v === null) {
      if (p.required) return `필수 파라미터 누락: ${key}`;
      continue;
    }
    switch (p.type) {
      case "string":
        if (typeof v !== "string") return `${key}: string 이어야 함`;
        if (p.enum && !p.enum.includes(v))
          return `${key}: ${p.enum.join("|")} 중 하나여야 함`;
        break;
      case "number":
        if (typeof v !== "number") return `${key}: number 여야 함`;
        break;
      case "boolean":
        if (typeof v !== "boolean") return `${key}: boolean 이어야 함`;
        break;
      case "string[]":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          return `${key}: string 배열이어야 함`;
        break;
      case "number[]":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "number"))
          return `${key}: number 배열이어야 함`;
        break;
      case "json":
        break; // 임의 JSON — 핸들러가 검증
    }
  }
  return null;
}

// 실행 계측 sink(A1 — P12 실행 가시성). 오케스트레이터가 soksak 에 내리는 명령이 곧 이
// 경로이므로, 여기 계측이 없으면 "무엇이 실행되는지 본다"가 성립하지 않는다. 주입식(테스트
// 격리·부트 전 no-op). params 는 키 목록만 — secret 등 민감값을 스트림에 싣지 않는다.
// 활동 트레이스 — 표준 응답 봉투를 그대로 나른다(사후 변환 없음). message 가 표준 답변,
// data 는 활동 허브가 별도 표시(hover). docs/MESSAGE-PROTOCOL.md.
export interface CommandTrace {
  command: string;
  // 명령 라벨 원본(LocalizedText) — 실행 창의 spec 에서 그대로 싣는다. 소비자(오케스트레이터 등)가
  // 자기 언어로 해소한다. 플러그인 명령은 실행 창에만 로드되므로 스트림이 라벨을 날라야 다른
  // 창에서도 raw 키 없이 표시된다(스트림 자족성).
  title?: LocalizedText;
  source: "ui" | "remote";
  danger?: "destructive" | "inject";
  paramKeys: string[];
  ok: boolean;
  code: string; // 항상(성공 "OK" 포함)
  message: string; // 표준 답변(성공·실패 모두)
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  // 낭독 문장 — effectiveSpeak(spec, outcome) 해소 결과. 없으면 낭독 금지 엔트리.
  // 표시 문장(message)과 대칭인 와이어 값: 스펙 필드 speak 와 같은 이름을 쓴다.
  speak?: string;
  media?: MediaContent; // 표시 미디어(이미지 등) — 피드가 그대로 렌더
  // 상관 부모(ctx.parent 관통) — 이 실행이 속한 대화 턴 id. 피드가 턴 세트로 폴딩한다.
  parentId?: string;
  // 실행 유래(ctx.origin 관통) — 시스템 유래("schedule" 등)는 무낭독·흐림 표시(§5).
  origin?: string;
}
let traceSink: ((t: CommandTrace) => void) | null = null;
export function setCommandTraceSink(fn: ((t: CommandTrace) => void) | null): void {
  traceSink = fn;
}

// 명령 실행. 결과는 항상 {ok:true,…} 또는 {ok:false,code,message}.
export async function execute(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const started = Date.now();
  // 응답 공통 필드(window·hint)를 모든 경로에 얹는다 — 성공/실패 어느 지점에서 나온 응답이든
  // 이 한 곳을 지난다(message 정규화가 normalizeOutcome 한 곳을 지나듯).
  const out = withCommonFields(await executeInner(name, params, ctx), name, ctx);
  const finished = Date.now();
  try {
    // 기록은 전량(§5 R2 — 사실은 전부 기록된다). 유일한 제외 = spec.trace === false:
    // 동일 사실의 이중 기록 방지(orchestrator.ask — chat.prompt/answer 가 그 턴의 대표 기록,
    // activity.recent 아님 주의: 조회도 사실이라 기록된다). 노출(흐림·무낭독)은 origin 축이
    // 선별할 뿐 기록 여부를 정하지 않는다. 미등록 명령의 실패 봉투도 그대로 계측.
    if (registry.get(name)?.trace !== false) {
      traceSink?.({
        command: name,
        title: registry.get(name)?.title,
        source: ctx.remote ? "remote" : "ui",
        danger: registry.get(name)?.danger,
        paramKeys: Object.keys(params),
        ok: out.ok,
        code: out.code,
        message: out.message,
        durationMs: finished - started,
        startedAt: started,
        finishedAt: finished,
        // 응답 data 는 싣지 않는다 — 기록은 관찰 요약(§5)이다. 실측: activity.recent 의 기록이
        // 조회 결과(그 안의 이전 기록까지)를 통째로 물어 75MB 행으로 자기증식, retention 의
        // json 파스가 226MB malloc → CEF PartitionAlloc 즉사(앱 전체 사망 5회의 원천).
        media: out.media,
        // 낭독 후보는 사람 유래만(§5) — 시스템 유래(스케줄러 등)는 스펙과 무관하게 침묵.
        speak: ctx.origin ? undefined : effectiveSpeak(registry.get(name), out),
        parentId: ctx.parent,
        origin: ctx.origin,
      });
    }
  } catch {
    // 계측 실패는 명령 실행에 영향을 주지 않는다.
  }
  return out;
}

async function executeInner(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const spec = registry.get(name);
  if (!spec) {
    return { ok: false, code: "UNKNOWN_COMMAND", message: `알 수 없는 명령: ${name}` };
  }
  // 기본형 문법 — CLI 가 JSON 아닌 단일 값을 {"_": 값} 으로 보낸다(sok plugin.install activity).
  // 스펙이 진실이므로 해석은 여기 한 곳: 필수 매개변수가 정확히 하나일 때 그 이름으로 옮긴다.
  // 둘 이상이거나 없으면 그대로 두어 validate 가 INVALID_PARAMS 로 도움말을 안내하게 한다.
  if (params && Object.keys(params).length === 1 && "_" in params) {
    const required = Object.entries(spec.params).filter(([, v]) => v.required);
    if (required.length === 1) {
      const [key, ps] = required[0];
      let v: unknown = params._;
      if (ps.type === "number") v = Number(v);
      else if (ps.type === "boolean") v = v === true || v === "true";
      params = { [key]: v };
    }
  }
  const invalid = validate(spec, params);
  if (invalid) return { ok: false, code: "INVALID_PARAMS", message: invalid };
  // 권한 게이트: 원격(AI/CLI) 호출에서 위험 명령은 정책 확인. UI(사람) 호출은 면제.
  if (ctx.remote && spec.danger && !permissionGate(spec.danger)) {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message: `차단된 ${spec.danger} 명령: ${name}(설정 → 권한에서 허용)`,
    };
  }
  try {
    // 기본값 채움.
    const filled: Record<string, unknown> = { ...params };
    for (const [key, p] of Object.entries(spec.params)) {
      if (filled[key] === undefined && p.default !== undefined) {
        filled[key] = p.default;
      }
    }
    const result = await spec.handler(filled, ctx);
    return normalizeOutcome(spec, result);
  } catch (e) {
    return { ok: false, code: "INTERNAL", message: String(e) };
  }
}

// 핸들러 반환(자유 객체 또는 {ok:false,…})을 표준 응답 봉투 {ok,code,message,data?}로 정규화한다.
// 성공: 예약키(ok/code/message) 분리 → 나머지는 data 로 중첩, message 는 spec.message(data) 가
// 소유한다(추측 계층·폴백 없음 — 모든 명령이 자기 답을 안다). 실패: code/message 보존, error 방언 흡수.
function normalizeOutcome(spec: CommandSpec | undefined, result: unknown): CommandOutcome {
  const raw: Record<string, unknown> =
    result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const pickData = (rest: Record<string, unknown>, existing: unknown): Record<string, unknown> | undefined => {
    if (existing && typeof existing === "object") return existing as Record<string, unknown>;
    return Object.keys(rest).length ? rest : undefined;
  };
  if (raw.ok === false) {
    const { ok: _o, code: rc, message: rm, error: re, data: rd, ...rest } = raw;
    const code = typeof rc === "string" ? rc : typeof re === "string" ? re : "INTERNAL";
    const message = typeof rm === "string" ? rm : typeof re === "string" ? re : "error";
    const data = pickData(rest, rd);
    return data ? { ok: false, code, message, data } : { ok: false, code, message };
  }
  const { ok: _ok, code: rc, message: _rm, data: rd, media: rmedia, ...rest } = raw;
  const data = pickData(rest, rd);
  const code = typeof rc === "string" ? rc : "OK";
  // message 는 spec 이 소유한다(예약키라 핸들러 반환의 message 는 버린다). spec 은 execute 에서만
  // 정규화를 부르므로 항상 존재한다 — undefined 는 타입가드일 뿐(도달 불가).
  const message = spec ? spec.message(data ?? {}) : code;
  const media =
    rmedia && typeof rmedia === "object" && typeof (rmedia as MediaContent).kind === "string"
      ? (rmedia as MediaContent)
      : undefined;
  const out: CommandOutcome = { ok: true, code, message };
  if (data) out.data = data;
  if (media) out.media = media;
  return out;
}

// 응답 공통 필드(창 label·hint)를 얹는 단일 지점 — execute 가 모든 경로를 여기로 통과시킨다.
// window 는 언제나, hint 는 제시할 게 있을 때만. hint 는 지시가 아니라 가능성의 제시다:
// "이런 것이 가능하다"를 알려 받은 쪽의 판단을 돕는다(강제 아님).
function withCommonFields(out: CommandOutcome, name: string, ctx: CommandContext): CommandOutcome {
  out.window = currentWindowLabel();
  if (out.ok) {
    // 성공 hint 는 명령 자신(spec.hint)이 짓는다. 최대 3개로 자른다. 던져도 응답을 깨지 않고
    // hint 만 생략한다 — 제시의 실패가 실행의 성공을 무를 수 없다.
    const spec = registry.get(name);
    if (spec?.hint) {
      try {
        out.hint = spec.hint(out.data ?? {}, ctx).slice(0, 3);
      } catch {
        // hint 계산 실패는 응답과 무관 — 제시가 빠질 뿐이다.
      }
    }
  } else {
    // 실패 hint 도 명령 자신이 먼저 짓는다(spec.hint 가 {code,message} 를 받아 원인별 안내 가능).
    // 명령이 비우거나 던지면 오류 코드별 표준 안내로 돌아간다 — 받은 쪽이 스스로 회복할 길을 연다.
    const spec = registry.get(name);
    if (spec?.hint) {
      try {
        const own = spec.hint({ code: out.code, message: out.message }, ctx).slice(0, 3);
        if (own.length) out.hint = own;
      } catch {
        /* 제시의 실패가 진단을 막지 않는다 */
      }
    }
    if (!out.hint) {
      const std = standardErrorHints(out.code, name);
      if (std) out.hint = std;
    }
  }
  return out;
}

// 오류 코드별 표준 안내(제시). 매핑 없는 코드는 hint 없음 — 과잉 안내를 만들지 않는다.
// cmd=제안 명령줄, why=왜 유용한지(tmsg 로 현재 언어 해소). INVALID_PARAMS 는 실제 명령 이름을 끼운다.
// UNKNOWN_COMMAND 지능형 해석기 — 미지의 명령 이름을 레지스트리 카탈로그와 대조해 원인별
// 안내(미설치→install, 비활성→enable)를 짓는다. 카탈로그·플러그인 상태는 상위 계층(catalogPlugins)
// 소유이므로 여기서는 주입점만 둔다(순환 의존 방지 — registry 는 상태 저장소를 모른다).
let unknownCommandResolver: ((name: string) => CommandHint[]) | null = null;
export function setUnknownCommandResolver(fn: (name: string) => CommandHint[]): void {
  unknownCommandResolver = fn;
}

function standardErrorHints(code: string, command: string): CommandHint[] | undefined {
  switch (code) {
    case "UNKNOWN_COMMAND": {
      // 해석기가 원인을 알아내면 그 안내가 우선한다(설치·활성 경로). 실패·부재 시 일반 탐색 안내.
      try {
        const resolved = unknownCommandResolver?.(command);
        if (resolved && resolved.length) return resolved.slice(0, 3);
      } catch {
        /* 해석 실패는 안내 품질 저하일 뿐 — 응답을 깨지 않는다 */
      }
      return [{ cmd: "sok commands", why: tmsg("hint.error.unknownCommand") }];
    }
    case "TARGET_NOT_FOUND":
      return [{ cmd: "sok state.tree", why: tmsg("hint.error.targetNotFound") }];
    case "INVALID_PARAMS":
      return [{ cmd: `sok help ${command}`, why: tmsg("hint.error.invalidParams", { command }) }];
    case "CONSENT_REQUIRED":
      return [{ cmd: "sok plugin.consent.preview '{\"id\":...}'", why: tmsg("hint.error.consentRequired") }];
    case "TIMEOUT":
      return [{ cmd: "sok state.tree", why: tmsg("hint.error.timeout") }];
    default:
      return undefined;
  }
}

// 낭독 문장 해소 — 활동 엔트리에 실리는 speak 와이어 값의 단일 계산점(§3, 축은 message/speak 둘뿐).
// 낭독은 **opt-in**: 명령이 speak 를 선언해야만 낭독된다(message 폴백 없음). message(표시)는 피드에
// 언제나 뜨지만, 읽기·진단 명령까지 전부 낭독하면 소음이 된다 — 낭독할 값어치는 명령이 speak 로
// 선언한다. speak 있으면 성공·실패 불문 speak(outcome)가 문장, "" → 침묵. 없으면 침묵(undefined).
export function effectiveSpeak(spec: CommandSpec | undefined, out: CommandOutcome): string | undefined {
  const s = spec?.speak ? spec.speak(out) : "";
  return s || undefined;
}
