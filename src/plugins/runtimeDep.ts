// runtimeDep — 외부 런타임 의존성(4-tuple)의 *순수 결정* 로직. IO 없음(앱/디스크 비의존) → 단위검증.
//   classifyHealth: 관찰(Observed) → Health 5상태. accept: Health → 수용 여부. nextAction: Health → 액션.
// IO(observe = probe/디스크 관찰, reach = 설치/다운로드/정리)는 reconcile 엔진(M3, Rust 경계)이 실행한다.
import { semverGte } from "./spec";

export type Health =
  | "ABSENT"
  | "PARTIAL"
  | "BROKEN"
  | "VERSION_MISMATCH"
  | "HEALTHY";

// 관찰 결과 — Rust(M3)가 디스크/probe 로 채운다. 순수 분류의 입력.
export interface Observed {
  present: boolean; // bin 이 PATH 에 존재
  working: boolean; // probe argv 가 exit 0(실제 작동)
  partial: boolean; // 설치 흔적(lib) 있으나 bin 미연결 — 어제 EEXIST 의 상태
  broken: boolean; // dangling 심링크 / 무결성 깨짐
  version?: string; // probe 가 추출한 버전
}

// "존재 == 작동" 폐기 — 관찰을 5상태로 분류. partial/broken 우선(복구 대상).
export function classifyHealth(o: Observed, minVersion?: string): Health {
  if (o.partial) return "PARTIAL";
  if (o.broken) return "BROKEN";
  if (!o.present) return "ABSENT";
  if (!o.working) return "BROKEN";
  if (minVersion && o.version && semverGte(o.version, minVersion) !== true) {
    return "VERSION_MISMATCH";
  }
  return "HEALTHY";
}

// 수용 술어 — HEALTHY 만. 빈 diff(=accept)가 정확성·멱등성의 동일 증명.
export function accept(health: Health): boolean {
  return health === "HEALTHY";
}

export type ReconcileAction = "noop" | "reach" | "cleanup-then-reach";

// 멱등 reconcile 의 결정(순수): HEALTHY=무동작, PARTIAL/BROKEN=정리 후 공급, 그 외=공급.
// 엔진은 액션 종류로 분기하지 않고 diff(accept 여부)로만 분기 — PARTIAL/BROKEN 의 cleanup 이 EEXIST 근본 해소.
export function nextAction(health: Health): ReconcileAction {
  switch (health) {
    case "HEALTHY":
      return "noop";
    case "PARTIAL":
    case "BROKEN":
      return "cleanup-then-reach";
    case "ABSENT":
    case "VERSION_MISMATCH":
      return "reach";
  }
}
