// conformance — 플러그인 contribution 의 declared≡actual 정합성(통합).
// v1 법칙: 매니페스트 선언(declared)과 런타임 실제 배선(actual)이 일치한다(양방향).
//  - gateContribution: undeclared-actual 거부(api.ts 4중 find+throw 를 하나로).
//  - missingRegistrations: declared-but-not-actual 감지(activate 후 inventory).
// 앱/DOM 비의존 순수 로직 — vitest 단위검증 대상.

// 계약 id 문법의 단일진실 = 스펙 패키지 contracts.ts (스키마 게이트와 같은 regex 를 본다).
// C2 정적 판정의 단일진실 = 스펙 패키지 transparency.ts (게이트·validate CLI 와 같은 함수를 본다).
import {
  C2_STATIC_ENFORCEMENT,
  CONTRACT_ID_RE,
  type EnforcementMode,
  type StaticTransparencyRule,
} from "./spec";
export { C2_STATIC_ENFORCEMENT, isContentView, transparencyViolations } from "./spec";
export type { EnforcementMode, StaticTransparencyRule } from "./spec";

// 선언(declared) 중 id 에 해당하는 엔트리를 찾아 반환. 없으면 fatal throw.
// 메시지: 매니페스트 contributes.<contributesKey> 에 선언되지 않은 <noun>: <id>
export function gateContribution<T>(opts: {
  contributesKey: string; // "commands" | "views" | "fileViewers" | "iconSets" ...
  noun: string; // 한글 명사("명령"/"뷰"/"파일 뷰어"/"셋") — 에러 메시지용
  id: string;
  declared: readonly T[];
  idOf: (entry: T) => string; // commands=name, 그 외=id
}): T {
  const found = opts.declared.find((e) => opts.idOf(e) === opts.id);
  if (!found) {
    throw new Error(
      `매니페스트 contributes.${opts.contributesKey} 에 선언되지 않은 ${opts.noun}: ${opts.id}`,
    );
  }
  return found;
}

// 선언됐는데 등록되지 않은 id 목록(선언 순서 보존). declared-but-not-actual 감지.
// 등록만 있고 선언 없는 건 여기서 다루지 않는다(그건 gateContribution 의 몫 — 양방향 분리).
export function missingRegistrations(
  declaredIds: readonly string[],
  registeredIds: readonly string[],
): string[] {
  const reg = new Set(registeredIds);
  return declaredIds.filter((id) => !reg.has(id));
}

// ── 결합 법칙 C2 — 투명성 3종(command·status·DOM) ────────────────────────────
// 모든 기능은 세 표면을 의무 노출한다. 정적 판정(매니페스트-전용: command-surface·view-nodes·
// content-view-status)과 그 시행 입법표(C2_STATIC_ENFORCEMENT)의 단일진실은 스펙 패키지
// transparency.ts 다 — 로더·설치본 게이트·validate CLI 가 전부 같은 함수·표를 소비한다(미러 금지).
// 여기 남는 것은 런타임 증거가 필요한 판정(viewStatusConformance)과 런타임 규칙을 합성한
// 전체 입법표(C2_ENFORCEMENT)뿐이다.
// 재입법 이력(정적 규칙의 후속 이력은 스펙 패키지 transparency.ts 가 이어 적는다):
//   2026-07-11 도입 — 위반 잔존이라 3종 전부 warn 출발(dev 홈 매니페스트 41개 실측):
//     command-surface 5 · view-nodes 6 · view-status 4/10.
//   2026-07-11 승격 — 정적 2종 위반 0 도달(11 플러그인 적합화 sweep) 후 command-surface·view-nodes 를
//     blocking 으로 승격. 기계 조건 = c2-transparency-scan 헤드리스 게이트 exit 0(make gates 배선).
//   2026-07-11 이관 — 정적 판정·입법표를 스펙 패키지로 이관(판정 단일화 — 게이트 미러 폐기),
//     status 축에 매니페스트 선언(contributes.views[].status)을 신설하고 그 부재를
//     content-view-status(warn 출발 — 래칫)로 판정한다.
// view-status(런타임 규칙)의 위반은 선언 밖 코드 보고(undeclared) 하나다. 순간 관찰의 null 은
// 위반이 아니다 — status 축의 원설계 의미론이 null=보고할 것 없음(정상)이고, transient 코드
// (connecting 등)는 관측창보다 빠를 수 있어 순간-미보고 규칙은 원리적으로 실측 불가하며, 정상
// 상태 코드 강제는 모든 탭에 배지 소음을 얹는다(완벽함 원칙). unreported 는 진단 정보로만 남긴다.
// 재입법 이력(view-status): 2026-07-11 warn 출발 → 2026-07-11 순간-미보고 규칙 폐지(기준 자체
// 오류 정정 — 위 근거) + 라이브 실측(debug 격리, 콘텐츠 뷰 2 마운트) undeclared=0 확인 후
// blocking 승격. 시행·실측 지점은 plugin.conformance(런타임 진단)와 발행 게이트(doctor)다.

// 전체 규칙 축 = 정적 3종(스펙 패키지) + 런타임 1종(view-status — 코어 소유).
export type TransparencyRule = StaticTransparencyRule | "view-status";
// 시행 모드 — C2·C3 가 공유하는 축(blocking=활성화 거부, warn=경고). TransparencyMode 는 기존 이름 호환.
export type TransparencyMode = EnforcementMode;

// 전체 시행 입법표 — 정적 규칙 모드는 스펙 패키지 표를 승계(단일진실)하고 런타임 규칙만 더한다.
// 이 표의 변경은 재입법 커밋이며 conformance.test.ts 의 핀 테스트가 동행 개정을 강제한다.
export const C2_ENFORCEMENT: Readonly<Record<TransparencyRule, TransparencyMode>> = {
  ...C2_STATIC_ENFORCEMENT,
  "view-status": "blocking",
};

export interface TransparencyViolation {
  rule: TransparencyRule;
  detail: string; // 위반 사실 서술(무엇이 몇 개인지) — 경고/거부 메시지에 그대로 실림
}

// ② view-status 의 판정 — 런타임 입력, 선언≡보고. 캐퍼빌리티는 코어 실존(viewRegistry
// PluginViewContext.setStatus → sessions view.status → status.query). 활성화 시점엔 뷰가 마운트
// 전이라 로더에서 판정 불가 — 시행 지점은 런타임 진단(plugin.conformance)·발행 게이트(doctor)다.
// 여기는 순수 판정만 둔다(플러그인 id 무유입 — 선언 배열과 관찰 배열만 받는다).
// 선언 = contributes.views[].status(보고 코드 목록, [] = 무상태 명시, undefined = 선언 부재).
// 판정 두 방향(각각 다른 규칙 축으로 시행):
//   unreported: 선언(비어있지 않음) 있고 미보고 → view-status 위반(약속 미이행).
//   undeclared: 보고 코드가 선언에 없음(부재·[]·목록 밖) → content-view-status 선언 누락 경고
//               (정적 판정은 선언 부재만 보고, 코드 누락은 런타임 실측으로만 드러난다).
// 선언 부재 + 미보고는 여기서 침묵한다 — 그 사실 자체가 정적 content-view-status 위반이다(이중보고 금지).
export interface ViewStatusObservation {
  viewId: string; // 마운트 인스턴스 id
  view: string; // 선언 뷰 id(contributes.views[].id)
  code: string | null; // 보고된 status code, null = 미보고
}

export interface ViewStatusJudgment {
  unreported: string[]; // 선언 있고 미보고 — view-status 위반 대상(마운트 순서 보존)
  undeclared: { viewId: string; view: string; code: string }[]; // 선언 밖 보고 — 선언 누락 경고
}

export function viewStatusConformance(
  declaredViews: readonly { id: string; status?: readonly string[] }[],
  observed: readonly ViewStatusObservation[],
): ViewStatusJudgment {
  const declByView = new Map(declaredViews.map((v) => [v.id, v.status]));
  const unreported: string[] = [];
  const undeclared: ViewStatusJudgment["undeclared"] = [];
  for (const o of observed) {
    const decl = declByView.get(o.view);
    if (o.code === null) {
      if (decl !== undefined && decl.length > 0) unreported.push(o.viewId);
    } else if (decl === undefined || !decl.includes(o.code)) {
      undeclared.push({ viewId: o.viewId, view: o.view, code: o.code });
    }
  }
  return { unreported, undeclared };
}

// 위반을 시행 모드로 분류 — blocking 위반은 거부 대상, warn 위반은 경고 대상. C2·C3 공용(단일진실).
export function partitionEnforcement<R extends string, V extends { rule: R }>(
  violations: readonly V[],
  enforcement: Readonly<Record<R, EnforcementMode>>,
): { blocking: V[]; warn: V[] } {
  const blocking: V[] = [];
  const warn: V[] = [];
  for (const v of violations) {
    (enforcement[v.rule] === "blocking" ? blocking : warn).push(v);
  }
  return { blocking, warn };
}

export function partitionTransparency(
  violations: readonly TransparencyViolation[],
  enforcement: Readonly<Record<TransparencyRule, TransparencyMode>> = C2_ENFORCEMENT,
): { blocking: TransparencyViolation[]; warn: TransparencyViolation[] } {
  return partitionEnforcement(violations, enforcement);
}

// ── 결합 법칙 C3 — L2 계약-핀: implements 선언의 generic 검사 ────────────────
// 매니페스트 implements: ["<scope>-spec@<major>"] 는 이 플러그인이 구현하는 계약의 선언이고,
// 소비자는 계약 id 로 구현체를 발견한다(contractDiscovery — 구현체 무차별). 계약이 요구하는 표면
// (어떤 command/view 가 있어야 하나)의 정의·검증은 계약 소유자(플러그인) 몫 — 코어는 어떤 계약도
// 모르므로(C1) 선언 자체의 성립만 generic 하게 본다: 형태·문법(NAMING §8)·중복.
// 재입법 이력: 2026-07-11 warn 출발(신설 축) → 2026-07-11 blocking 승격 — 스키마 랜딩(P0.5)
// 후 설치본 실측 위반 0(implements 선언 보유 플러그인 0, L2 는 옵트인이라 무선언=합법).
// 이후 완화·재승격은 명시 재입법 커밋으로만 한다(C4·C5). 핀 테스트가 동행 개정을 강제한다.

export type ImplementsRule =
  | "implements-shape"
  | "implements-grammar"
  | "implements-duplicate";

export const C3_ENFORCEMENT: Readonly<Record<ImplementsRule, EnforcementMode>> = {
  "implements-shape": "blocking",
  "implements-grammar": "blocking",
  "implements-duplicate": "blocking",
};

export interface ImplementsViolation {
  rule: ImplementsRule;
  detail: string; // 위반 사실 서술 — 경고/거부 메시지에 그대로 실림
}

// implements 원값(rawImplements) → 위반 목록. undefined = 무선언(합법 — L2 는 옵트인).
// 비문자열 항목은 shape 위반으로 보고하되 문자열 항목의 문법·중복 검사는 계속한다(은폐 0).
export function implementsViolations(raw: unknown): ImplementsViolation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return [{ rule: "implements-shape", detail: `implements 가 배열이 아님(${typeof raw})` }];
  }
  const out: ImplementsViolation[] = [];
  const nonString = raw.filter((v) => typeof v !== "string");
  if (nonString.length > 0) {
    out.push({
      rule: "implements-shape",
      detail: `비문자열 항목 ${nonString.length}개 — implements 는 계약 id 문자열 배열`,
    });
  }
  const entries = raw.filter((v): v is string => typeof v === "string");
  const offGrammar = entries.filter((e) => !CONTRACT_ID_RE.test(e));
  if (offGrammar.length > 0) {
    out.push({
      rule: "implements-grammar",
      detail: `계약 id 문법(<scope>-spec@<major>, NAMING §8) 위반: ${offGrammar.join(", ")}`,
    });
  }
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const e of entries) {
    if (seen.has(e)) dup.add(e);
    seen.add(e);
  }
  if (dup.size > 0) {
    out.push({ rule: "implements-duplicate", detail: `중복 선언: ${[...dup].join(", ")}` });
  }
  return out;
}

// nodes 의 declared≡actual 진단. actual = DOM 의 data-node(scanNodes 의 nodePath).
// 동적 리스트 노드는 "id/key" 형태라 base id(첫 세그먼트)로 매칭한다. nodes 는 register API 가 없는
// contribution 이므로 게이트(throw)가 아니라 진단을 낸다:
//   missing = 선언했으나 DOM 에 미배선(declared→actual), orphan = DOM 에 있으나 미선언(actual→declared).
export function nodeConformance(
  declaredIds: readonly string[],
  scannedNodePaths: readonly string[],
): { missing: string[]; orphan: string[] } {
  const declared = new Set(declaredIds);
  const scannedBase = new Set(scannedNodePaths.map((p) => p.split("/")[0]));
  return {
    missing: declaredIds.filter((id) => !scannedBase.has(id)),
    orphan: [...scannedBase].filter((id) => !declared.has(id)),
  };
}

// ── 유닛 선택의 단일진실 — 번들이 유닛명을 굳혔는가(발행 경계) ────────────────────
// 어느 엔진 유닛을 스폰할지는 매니페스트 sidecars[] 가 정한다. 번들에 "sidecar:<이름>" 을 상수로
// 굳히면 매니페스트만 바꿨을 때 declared ≠ actual 이 된다. 런타임 스폰 게이트가 그 어긋남을 loud
// 하게 잡지만(app.process.spawn), 그건 실행해 봐야 안다 — 발행 전에 정적으로도 잡는다.
//
// 선언된 이름이라도 리터럴로 박혀 있으면 위반이다: 매니페스트를 바꾸는 순간 그 리터럴이 거짓이
// 되고, 그때는 앱이 죽는 방식으로만 알게 된다. 이름은 app.process.sidecarName(계약)이 준다.

export interface SidecarSpawnViolation {
  /** 번들에 굳어 있는 유닛명. */
  unit: string;
  /** 매니페스트가 그 이름을 선언하고는 있는가(선언돼 있어도 리터럴은 위반이다 — 위 주석). */
  declared: boolean;
}

/** 번들 소스에서 `sidecar:<이름>` 리터럴을 찾는다. 하나라도 있으면 유닛 선택이 매니페스트가 아니라
 *  번들에 있다는 뜻이다. */
export function sidecarSpawnViolations(
  bundle: string,
  declared: ReadonlyArray<{ name: string }>,
): SidecarSpawnViolation[] {
  const names = new Set(declared.map((d) => d.name));
  const out: SidecarSpawnViolation[] = [];
  const seen = new Set<string>();
  for (const m of bundle.matchAll(/["'`]sidecar:([a-z0-9][a-z0-9-]*)["'`]/g)) {
    const unit = m[1];
    if (seen.has(unit)) continue;
    seen.add(unit);
    out.push({ unit, declared: names.has(unit) });
  }
  return out;
}

// ── 부르는 이름이 실제로 해소되는가 ────────────────────────────────────────────
// 플러그인이 `app.commands.execute("<이름>")` 로 부르는 이름은 아무도 검사하지 않았다. 그래서
// 코어가 명령을 개명·방출하면 그 이름을 부르던 플러그인은 조용히 죽는다 — 죽은 호출은 예외도
// 로그도 남기지 않고, 그 기능을 아무도 안 쓰면 몇 판이 지나도 드러나지 않는다(실측: 브라우저가
// 플러그인으로 방출되면서 `browser.eval`·`browser.open` 이 사라졌고, 그것을 부르던 세 플러그인의
// 기능이 죽은 채로 남았다). 선언≡실제의 나머지 절반이다: 등록하는 것만 보지 말고 **부르는 것**도 본다.
export interface CommandCallScan {
  /** 리터럴로 적힌 명령 이름(중복 제거). */
  literals: string[];
  /** 문자열 조립으로 만든 호출 수 — 정적으로 판정 불가라 세기만 한다(무음 은폐 금지). */
  dynamic: number;
}

/** 번들 소스에서 execute 로 넘어가는 명령 이름을 걷는다. 번들러는 프로퍼티 이름을 보존하므로
 *  minify 된 번들에서도 `.commands.execute(` 는 남는다. 템플릿 보간(${…})은 리터럴이 아니다. */
export function executedCommandNames(bundle: string): CommandCallScan {
  const literals = new Set<string>();
  let dynamic = 0;
  const re = /\.commands\s*\.\s*execute\s*\(\s*(?:(["'])([^"'\n]+)\1|`([^`]*)`)/g;
  for (const m of bundle.matchAll(re)) {
    const quoted = m[2];
    const template = m[3];
    // 조각을 이어 붙여 만든 이름은 정적으로 알 수 없다 — 앞 조각을 이름으로 세면 멀쩡한 호출을
    // 죽은 호출로 고발한다(실측: `execute(PREFIX + name)` 의 PREFIX 가 미해소로 잡혔다).
    const after = bundle.slice((m.index ?? 0) + m[0].length).trimStart();
    if (after.startsWith("+")) {
      dynamic += 1;
      continue;
    }
    if (quoted !== undefined) {
      literals.add(quoted);
      continue;
    }
    if (template !== undefined) {
      if (template.includes("${")) dynamic += 1;
      else literals.add(template);
    }
  }
  return { literals: [...literals].sort(), dynamic };
}

/** 해소되지 않는 호출 = 코어 카탈로그에도, 설치된 어떤 플러그인의 선언에도 없는 이름.
 *  대상이 비활성이어도 선언은 남으므로, 여기 걸리는 것은 "어디에도 없는 이름"뿐이다. */
export function unresolvedCommandCalls(
  literals: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  return literals.filter((n) => !known.has(n));
}
