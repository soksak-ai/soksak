// plugin service(제3 실행 형태) 선언 축 — 규범은 docs/PLUGIN-SERVICE.md(PS 조항).
// 매니페스트 스키마의 단일 심판은 parseManifest(spec.ts) — 이 모듈은 그 판정의 service
// 축(선언 파싱·PS 정합 규칙)이다. spec.ts 가 재수출한다.
import {
  SERVICE_CONTRACT_ID_RE,
  type ContractRequirement,
  parseContractRequirement,
} from "./contracts.js";
import {
  checkDuplicates,
  checkKnownKeys,
  isNonEmptyString,
  isRecord,
} from "./util.js";

// 코어가 말하는 plugin service 와이어 계약(PS5·PS6). Rust 측 단일진실은
// soksak-spec-service 크레이트 — 이 상수는 TS 표면 미러이며 교차언어 골든 테스트가
// 동치를 봉인한다. 계약 id 는 "soksak-spec-" 로 시작해 플러그인 id(soksak-plugin-<name>)와
// 절대 충돌하지 않는다(PS6 — C1 스캔이 코어 소스의 플러그인 id 토큰을 적발하나 계약 id 는 제외).
export const SERVICE_CONTRACT_REQUIREMENT: ContractRequirement = Object.freeze({
  id: "soksak-spec-service",
  range: "0.0.1",
});

// 커맨드 파라미터 스펙 — 코어 레지스트리 ParamSpec(src/commands/registry.ts)과 동형.
// bind:"service" 커맨드는 스펙 전문을 매니페스트 데이터로 선언한다(PS3) — 프록시 등록이
// 이 선언을 그대로 레지스트리에 공급한다(합성 핸들러, 손 작성 금지).
export const PARAM_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "json",
] as const;
export type ServiceParamType = (typeof PARAM_TYPES)[number];
export interface ServiceParamSpec {
  type: ServiceParamType;
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

// bind:"service" 커맨드가 매니페스트에 추가로 선언하는 스펙 필드(PS3).
// description = 영어 base(LLM 발견 표면 — CommandSpec.description 동형, 사람 라벨은 title).
// triggers = 비영어 트리거 단어 맵(composeTriggers 합성 — docs/I18N.md §3).
export interface ServiceCommandFields {
  bind?: "service";
  description?: string;
  triggers?: Record<string, string>;
  params?: Record<string, ServiceParamSpec>;
  returns?: string;
}
export const SERVICE_COMMAND_KEYS = [
  "bind",
  "description",
  "triggers",
  "params",
  "returns",
] as const;

// 서비스 선언(PS1·PS5·PS9·PS15) — sidecar 는 sidecars[] 의 상주 바이너리 참조,
// interface 는 와이어 계약 id, subscribe 는 코어가 브리지해 push 할 bus 토픽.
export interface ServiceDecl {
  sidecar: string;
  interface: ContractRequirement;
  subscribe: string[];
}

// 스케줄 트리거 — 정확히 하나의 변형(reach 전략과 동형 규율). reconcile 은 타이머가
// 없는 poke 발화 전용(schedule.rs Reconcile 동형), everyMs 는 양의 정수 주기, cron 은
// 표준 5필드 표현식(해석은 코어 스케줄러가 소유 — 여기서는 형식만).
export type ScheduleTrigger =
  | { reconcile: true }
  | { everyMs: number }
  | { cron: string };

// 매니페스트 스케줄 선언(PS14) — 코어가 owner 를 스탬핑하고 bind 시 등록·poke,
// unbind 시 owner 로 취소한다. command 는 contributes.commands 의 선언을 참조한다.
export interface ContributedSchedule {
  name: string;
  command: string;
  params?: Record<string, unknown>;
  trigger: ScheduleTrigger;
  timeoutMs?: number;
  zombieBackstopMs?: number;
}

const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// 구독 토픽 — v1 은 창 bus 축만("bus:" 접두 + 토픽). 토픽 자체는 콜론 네임스페이스 허용.
const SUBSCRIBE_RE = /^bus:[a-z0-9][a-z0-9:._-]*$/;
// cron 5필드(분 시 일 월 요일) — 필드 문법 해석은 코어 스케줄러 소유, 여기선 골격만.
const CRON_RE = /^\S+ \S+ \S+ \S+ \S+$/;

// 최소 정보를 담는 커맨드 뷰 — spec.ts 의 ContributedCommand 전체에 의존하지 않는다
// (순환 import 금지: spec.ts → service.ts 단방향).
export interface ServiceCommandView {
  name: string;
  bind?: "service";
}

// hello ops 대조의 단일 원천(PS3) — bind:"service" 커맨드 이름의 정렬 집합.
// 코어 bind 원장·프록시 등록·hello 검증이 전부 이 파생을 소비한다.
export function serviceOps(manifest: {
  contributes: { commands: ServiceCommandView[] };
}): string[] {
  return manifest.contributes.commands
    .filter((c) => c.bind === "service")
    .map((c) => c.name)
    .sort();
}

// 톱레벨 service 블록 파싱 — 형식만(교차 정합은 validateServiceRules). 실패 시 undefined.
export function parseServiceDecl(
  raw: unknown,
  errors: string[],
): ServiceDecl | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push("service: 객체({ sidecar, interface, subscribe? })여야 함");
    return undefined;
  }
  checkKnownKeys(raw, ["sidecar", "interface", "subscribe"], "service", errors);
  let bad = false;
  if (!isNonEmptyString(raw.sidecar) || !SERVICE_NAME_RE.test(raw.sidecar.trim())) {
    errors.push("service.sidecar: 사이드카 이름(^[a-z0-9][a-z0-9-]*$) 필수");
    bad = true;
  }
  const interfaceRef = parseContractRequirement(
    raw.interface,
    "service.interface",
    errors,
    SERVICE_CONTRACT_ID_RE,
  );
  if (!interfaceRef) bad = true;
  const subscribe: string[] = [];
  if (raw.subscribe !== undefined) {
    if (
      !Array.isArray(raw.subscribe) ||
      !raw.subscribe.every((t) => isNonEmptyString(t) && SUBSCRIBE_RE.test(t.trim()))
    ) {
      errors.push('service.subscribe: "bus:<topic>" 문자열 배열(PS15 — v1 은 bus 축만)');
      bad = true;
    } else {
      subscribe.push(...raw.subscribe.map((t) => (t as string).trim()));
      checkDuplicates(subscribe, "service.subscribe", errors);
    }
  }
  if (bad) return undefined;
  return {
    sidecar: (raw.sidecar as string).trim(),
    interface: interfaceRef!,
    subscribe,
  };
}

// 커맨드 항목의 service 스펙 필드 파싱(PS3). bind 없는 커맨드의 스펙 데이터 선언은
// 거부한다 — JS 커맨드의 스펙은 런타임 register 가 소유한다(이원 소유 금지).
// 실패 시 null(항목 거부), 성공 시 병합할 필드 객체.
export function parseCommandServiceFields(
  v: Record<string, unknown>,
  label: string,
  errs: string[],
): ServiceCommandFields | null {
  if (v.bind === undefined) {
    for (const key of ["description", "triggers", "params", "returns"] as const) {
      if (v[key] !== undefined) {
        errs.push(`${label}.${key}: bind:"service" 커맨드 전용(JS 커맨드 스펙은 런타임 소유)`);
        return null;
      }
    }
    return {};
  }
  if (v.bind !== "service") {
    errs.push(`${label}.bind: "service" 만 허용`);
    return null;
  }
  if (!isNonEmptyString(v.description)) {
    errs.push(`${label}.description: bind:"service" 는 스펙 전문이 매니페스트 데이터(PS3) — 영어 base 필수`);
    return null;
  }
  const out: ServiceCommandFields = {
    bind: "service",
    description: v.description.trim(),
  };
  if (v.triggers !== undefined) {
    if (
      !isRecord(v.triggers) ||
      !Object.entries(v.triggers).every(([, val]) => isNonEmptyString(val))
    ) {
      errs.push(`${label}.triggers: {언어: 트리거 단어} 맵`);
      return null;
    }
    out.triggers = v.triggers as Record<string, string>;
  }
  const params: Record<string, ServiceParamSpec> = {};
  if (v.params !== undefined) {
    if (!isRecord(v.params)) {
      errs.push(`${label}.params: 객체(이름 → ParamSpec)여야 함`);
      return null;
    }
    for (const [name, spec] of Object.entries(v.params)) {
      const plabel = `${label}.params.${name}`;
      if (!isRecord(spec)) {
        errs.push(`${plabel}: 객체여야 함`);
        return null;
      }
      checkKnownKeys(spec, ["type", "description", "required", "enum", "default"], plabel, errs);
      if (typeof spec.type !== "string" || !PARAM_TYPES.includes(spec.type as ServiceParamType)) {
        errs.push(`${plabel}.type: ${PARAM_TYPES.join("|")}`);
        return null;
      }
      if (!isNonEmptyString(spec.description)) {
        errs.push(`${plabel}.description: 비공백 문자열 필수`);
        return null;
      }
      if (spec.required !== undefined && typeof spec.required !== "boolean") {
        errs.push(`${plabel}.required: boolean`);
        return null;
      }
      if (spec.enum !== undefined) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0 || !spec.enum.every(isNonEmptyString)) {
          errs.push(`${plabel}.enum: 비공백 문자열 배열`);
          return null;
        }
      }
      const p: ServiceParamSpec = {
        type: spec.type as ServiceParamType,
        description: spec.description.trim(),
      };
      if (spec.required !== undefined) p.required = spec.required as boolean;
      if (spec.enum !== undefined) p.enum = (spec.enum as string[]).map((e) => e.trim());
      if (spec.default !== undefined) p.default = spec.default;
      params[name] = p;
    }
    // 미지 키 적발이 있었다면 위에서 return 하지 않았어도 errs 로 거부된다(all-or-nothing).
  }
  out.params = params;
  if (v.returns !== undefined) {
    if (!isNonEmptyString(v.returns)) {
      errs.push(`${label}.returns: 비공백 문자열`);
      return null;
    }
    out.returns = v.returns.trim();
  } else {
    out.returns = "object";
  }
  return out;
}

// contributes.schedules 파싱(PS14) — 형식만(command 참조 정합은 validateServiceRules).
export function parseSchedules(raw: unknown, errors: string[]): ContributedSchedule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("contributes.schedules: 배열이어야 함");
    return [];
  }
  const out: ContributedSchedule[] = [];
  raw.forEach((item, i) => {
    const label = `contributes.schedules[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${label}: 객체가 아님`);
      return;
    }
    checkKnownKeys(
      item,
      ["name", "command", "params", "trigger", "timeoutMs", "zombieBackstopMs"],
      label,
      errors,
    );
    if (!isNonEmptyString(item.name) || !SERVICE_NAME_RE.test(item.name.trim())) {
      errors.push(`${label}.name: ^[a-z0-9][a-z0-9-]*$ 필수`);
      return;
    }
    if (!isNonEmptyString(item.command)) {
      errors.push(`${label}.command: 선언된 커맨드 이름 필수`);
      return;
    }
    if (item.params !== undefined && !isRecord(item.params)) {
      errors.push(`${label}.params: 객체`);
      return;
    }
    const trigger = parseTrigger(item.trigger, label, errors);
    if (trigger === null) return;
    for (const key of ["timeoutMs", "zombieBackstopMs"] as const) {
      if (item[key] !== undefined && (!Number.isInteger(item[key]) || (item[key] as number) <= 0)) {
        errors.push(`${label}.${key}: 양의 정수(ms)`);
        return;
      }
    }
    const sched: ContributedSchedule = {
      name: item.name.trim(),
      command: item.command.trim(),
      trigger,
    };
    if (item.params !== undefined) sched.params = item.params as Record<string, unknown>;
    if (item.timeoutMs !== undefined) sched.timeoutMs = item.timeoutMs as number;
    if (item.zombieBackstopMs !== undefined) sched.zombieBackstopMs = item.zombieBackstopMs as number;
    out.push(sched);
  });
  checkDuplicates(out.map((s) => s.name), "contributes.schedules.name", errors);
  return out;
}

function parseTrigger(raw: unknown, label: string, errors: string[]): ScheduleTrigger | null {
  if (!isRecord(raw)) {
    errors.push(`${label}.trigger: 객체({reconcile:true}|{everyMs}|{cron}) 필수`);
    return null;
  }
  const variants = (["reconcile", "everyMs", "cron"] as const).filter((k) => k in raw);
  if (variants.length !== 1) {
    errors.push(`${label}.trigger: reconcile|everyMs|cron 중 정확히 하나`);
    return null;
  }
  const v = variants[0];
  if (v === "reconcile") {
    if (raw.reconcile !== true) {
      errors.push(`${label}.trigger.reconcile: true 만 허용`);
      return null;
    }
    return { reconcile: true };
  }
  if (v === "everyMs") {
    if (!Number.isInteger(raw.everyMs) || (raw.everyMs as number) <= 0) {
      errors.push(`${label}.trigger.everyMs: 양의 정수(ms)`);
      return null;
    }
    return { everyMs: raw.everyMs as number };
  }
  if (!isNonEmptyString(raw.cron) || !CRON_RE.test(raw.cron.trim())) {
    errors.push(`${label}.trigger.cron: 5필드 cron 표현식`);
    return null;
  }
  return { cron: raw.cron.trim() };
}

// PS 정합 규칙(교차 검증) — parseManifest 가 contributes 파싱 뒤 1회 호출한다.
// PS3: bind:"service" ⇔ service 선언 + 서비스는 커맨드를 소유(≥1).
// PS4: entry:null ⇒ service 선언 ∧ 전 커맨드 bind:"service" ∧ 코드-필요 기여 0
//      (views·overlays·nodes·fileViewers·iconSets — 런타임 provider 바인딩이 필요한 축).
//      headerActions/statusItems는 host-declarative command binding이라 service command만으로 합법.
// PS9: service.sidecar 는 sidecars[] 참조(배급·스테이징은 사이드카 법 상속).
// PS14: schedules ⇒ service(수명 소유자), command 는 선언 참조.
export function validateServiceRules(
  m: {
    service: ServiceDecl | undefined;
    commands: ServiceCommandView[];
    schedules: ContributedSchedule[];
    codeBoundCounts: Record<string, number>; // views/overlays/nodes/fileViewers/iconSets → 개수
    sidecarNames: string[];
    permissions: readonly string[];
    entryIsNull: boolean;
  },
  errors: string[],
): void {
  const boundOps = m.commands.filter((c) => c.bind === "service");
  if (m.service === undefined) {
    if (boundOps.length > 0) {
      errors.push('contributes.commands: bind:"service" 는 톱레벨 service 선언 필수(PS3)');
    }
    if (m.schedules.length > 0) {
      errors.push("contributes.schedules: service 선언 필수(PS14 — 수명 소유자 부재)");
    }
  } else {
    if (boundOps.length === 0) {
      errors.push('service: bind:"service" 커맨드 최소 1개 필요(PS3 — 서비스는 커맨드를 소유한다)');
    }
    if (!m.sidecarNames.includes(m.service.sidecar)) {
      errors.push(`service.sidecar: sidecars[] 에 "${m.service.sidecar}" 선언 필요(PS9 — 배급은 사이드카 법 상속)`);
    }
    if (!m.permissions.includes("service")) {
      errors.push('service: "service" 권한 선언 필요(caution — 동의 고지)');
    }
  }
  const declaredNames = new Set(m.commands.map((c) => c.name));
  for (const s of m.schedules) {
    if (!declaredNames.has(s.command)) {
      errors.push(`contributes.schedules["${s.name}"].command: 선언되지 않은 커맨드 "${s.command}"(PS14)`);
    }
  }
  if (m.entryIsNull) {
    if (m.service === undefined) {
      errors.push("entry: null 은 service 선언 필수(PS4 — 순수 계약 플러그인)");
    }
    const jsBound = m.commands.filter((c) => c.bind !== "service");
    if (jsBound.length > 0) {
      errors.push(
        `entry: null 은 전 커맨드 bind:"service" 필수(PS4) — JS 커맨드 ${jsBound.length}개 존재`,
      );
    }
    for (const [key, count] of Object.entries(m.codeBoundCounts)) {
      if (count > 0) {
        errors.push(`entry: null 은 코드-필요 기여 금지(PS4) — contributes.${key} ${count}개 존재`);
      }
    }
  }
}
