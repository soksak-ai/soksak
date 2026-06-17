// Command Registry — soksak 전 기능의 단일 진실.
// 모든 기능은 여기 등록된 command 하나로 표현되고, CLI(sok)/MCP/UI 는 호출자일 뿐이다.
// 문서(sok help/docs)와 MCP tool 정의도 이 스펙에서 생성된다 — 코드와 어긋날 수 없다.

import type { CmdErrCode } from "../state/sessions";

// 파라미터 스펙(JSON 직렬화 가능 — CLI/MCP/문서 생성에 그대로 쓰임).
export interface ParamSpec {
  // json = 임의 JSON 값(핸들러가 직접 검증).
  type: "string" | "number" | "boolean" | "string[]" | "number[]" | "json";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  default?: unknown;
}

export interface CommandSpec {
  description: string;
  params: Record<string, ParamSpec>;
  // 성공 응답 형태 설명(매뉴얼용).
  returns: string;
  // 발생 가능한 에러 코드.
  errors?: readonly (CmdErrCode | "INTERNAL" | "TIMEOUT")[];
  // CLI 사용 예시(매뉴얼용).
  examples?: readonly string[];
  // 위험 분류(원격/AI 호출 권한 게이트 대상): destructive=닫기·제거, inject=입력 주입.
  danger?: "destructive" | "inject";
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
}

// 권한 게이트 콜백(설정 store 를 registry 가 직접 알지 않게 주입).
// danger 분류에 대해 허용 여부를 돌려준다.
let permissionGate: (danger: "destructive" | "inject") => boolean = () => true;

export function setPermissionGate(
  fn: (danger: "destructive" | "inject") => boolean,
): void {
  permissionGate = fn;
}

export type CommandError = {
  ok: false;
  code:
    | CmdErrCode
    | "INTERNAL"
    | "TIMEOUT"
    | "UNKNOWN_COMMAND"
    | "INVALID_PARAMS"
    | "PERMISSION_DENIED";
  message: string;
};
export type CommandOutcome = ({ ok: true } & object) | CommandError;

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

// 카탈로그(핸들러 제외, 직렬화 가능) — sok commands/help/docs/MCP tool 목록의 원천.
export function catalogJson(): {
  name: string;
  description: string;
  params: Record<string, Omit<ParamSpec, never>>;
  returns: string;
  errors: readonly string[];
  examples: readonly string[];
}[] {
  return [...registry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => ({
      name,
      description: s.description,
      params: s.params,
      returns: s.returns,
      errors: s.errors ?? [],
      examples: s.examples ?? [],
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

// 명령 실행. 결과는 항상 {ok:true,…} 또는 {ok:false,code,message}.
export async function execute(
  name: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const spec = registry.get(name);
  if (!spec) {
    return { ok: false, code: "UNKNOWN_COMMAND", message: `알 수 없는 명령: ${name}` };
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
    // handler 가 CmdResult 형태({ok:…})면 그대로, 아니면 ok 래핑.
    if (result && typeof result === "object" && "ok" in result) {
      return result as CommandOutcome;
    }
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, code: "INTERNAL", message: String(e) };
  }
}
