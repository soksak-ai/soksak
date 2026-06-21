// runtimeDep — 외부 런타임 의존성(4-tuple)의 *순수 결정* 로직. IO 없음(앱/디스크 비의존) → 단위검증.
//   classifyHealth: 관찰(Observed) → Health 5상태. accept: Health → 수용 여부. nextAction: Health → 액션.
// IO(observe = probe/디스크 관찰, reach = 설치/다운로드/정리)는 reconcile 엔진(M3, Rust 경계)이 실행한다.
import { semverGte, type LibraryDep, type ProgramPlatform } from "./spec";

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

// probe stdout → 버전(순수). observe.versionRe 가 "actual" 버전을 뽑는다(캡처그룹 1 우선, 없으면 전체 매치).
// versionRe 미선언이면 추출 불가(undefined) → classifyHealth 가 minVersion 비교를 건너뛴다(존재만 본다).
export function parseProbeVersion(
  stdout: string,
  versionRe?: string,
): string | undefined {
  if (!versionRe) return undefined;
  const m = new RegExp(versionRe).exec(stdout);
  if (!m) return undefined;
  return m[1] ?? m[0];
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

// 공급(reach) 실행 종류 — IO 엔진(reconcileDependencies)이 그대로 실행한다.
export type ReachExec =
  | { kind: "command"; command: string } // process_spawn/터미널 설치 명령
  | { kind: "vendor"; vendorPath: string; sha256: string } // 저자 번들 바이트 sha256 검증 후 링크
  | { kind: "fetch"; url: string; sha256: string }; // download_verify(다운로드+sha256)

export interface ReconcileStep {
  action: ReconcileAction;
  reach?: ReachExec; // action !== noop 일 때만
}

// dep + 관찰(Observed) → reconcile 단계(순수): action(noop/reach/cleanup-then-reach) + reach 실행 종류.
// reach 우선순위: reach.vendor/fetch/command > 레거시 install. 이 플랫폼 공급 수단 없으면 noop.
export function reconcilePlan(
  dep: LibraryDep,
  observed: Observed,
  platform: ProgramPlatform,
): ReconcileStep {
  const health = classifyHealth(observed, dep.accept?.minVersion);
  if (accept(health)) return { action: "noop" };
  const reach = reachExec(dep, platform);
  if (!reach) return { action: "noop" }; // 이 플랫폼 공급 수단 없음 → 강제 X(§0-4)
  return { action: nextAction(health), reach };
}

function reachExec(dep: LibraryDep, platform: ProgramPlatform): ReachExec | null {
  const r = dep.reach;
  if (r) {
    if ("vendor" in r) {
      return { kind: "vendor", vendorPath: r.vendor.path, sha256: r.vendor.sha256 };
    }
    if ("fetch" in r) {
      const url = r.fetch.url[platform];
      const sha256 = r.fetch.sha256[platform];
      return url && sha256 ? { kind: "fetch", url, sha256 } : null;
    }
    if ("command" in r) {
      const command = r.command[platform];
      return command ? { kind: "command", command } : null;
    }
  }
  const command = dep.install[platform];
  return command ? { kind: "command", command } : null;
}
