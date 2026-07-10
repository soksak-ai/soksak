// conformance — 플러그인 contribution 의 declared≡actual 정합성(통합).
// v1 법칙: 매니페스트 선언(declared)과 런타임 실제 배선(actual)이 일치한다(양방향).
//  - gateContribution: undeclared-actual 거부(api.ts 4중 find+throw 를 하나로).
//  - missingRegistrations: declared-but-not-actual 감지(activate 후 inventory).
// 앱/DOM 비의존 순수 로직 — vitest 단위검증 대상.

// 계약 id 문법의 단일진실 = 스펙 패키지 contracts.ts (스키마 게이트와 같은 regex 를 본다).
import { CONTRACT_ID_RE } from "./spec";

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
// 모든 기능은 세 표면을 의무 노출한다. 규칙은 순수 판정, 시행 모드는 C2_ENFORCEMENT 가 단일진실.
// blocking 승격은 위반 0 실측 + 명시 재입법 커밋으로만 한다(C5 — 무언 완화·무언 승격 둘 다 금지).
// 도입 시점 실측(2026-07-11, dev 홈 플러그인 매니페스트 41개, scripts/gates/c2-transparency-scan.mjs).
// 위반 잔존이라 3종 전부 warn 출발. 개별 위반 목록은 코어에 두지 않는다(C1 — 코어는 generic만):
//   command-surface 위반 5 (뷰축 2 / 프로그램축 2 / 파일뷰어축 1)
//   view-status     위반 4/10 (콘텐츠 뷰 중 setStatus 미채택 — 런타임 실측, plugin.conformance)
//   view-nodes      위반 6
// 정적 2종의 승격 기계 조건 = c2-transparency-scan 헤드리스 게이트의 exit 0. view-status 는 런타임
// 규칙이라 헤드리스 매니페스트 스캔 대상 밖 — 시행·실측 지점은 plugin.conformance(마운트된 콘텐츠 뷰).

export type TransparencyRule = "command-surface" | "view-status" | "view-nodes";
// 시행 모드 — C2·C3 가 공유하는 축(blocking=활성화 거부, warn=경고). TransparencyMode 는 기존 이름 호환.
export type EnforcementMode = "blocking" | "warn";
export type TransparencyMode = EnforcementMode;

// 시행 입법표. 이 표의 변경은 재입법 커밋이며 conformance.test.ts 의 핀 테스트가 동행 개정을 강제한다.
export const C2_ENFORCEMENT: Readonly<Record<TransparencyRule, TransparencyMode>> = {
  "command-surface": "warn",
  "view-status": "warn",
  "view-nodes": "warn",
};

export interface TransparencyViolation {
  rule: TransparencyRule;
  detail: string; // 위반 사실 서술(무엇이 몇 개인지) — 경고/거부 메시지에 그대로 실림
}

// 매니페스트 정적 규칙 2종의 판정(활성화 경계에서 카운트만으로 판정 가능).
//   ① command-surface: 기능 보유(views>0 ∨ programs>0 ∨ fileViewers>0) ∧ commands=0 → 위반
//   ③ view-nodes: views>0 ∧ nodes=0 → 위반(ui.tree 부재 = 주소 기반 클릭 E2E 불가)
// 기능 보유 술어는 세 기여축(뷰·프로그램·파일 뷰어) 전부를 센다 — 파일 뷰어만 기여하는
// 플러그인(콘텐츠로 파일을 여는 렌더러)도 command 로 조회·조작면을 노출해야 한다(false negative 제거).
export function transparencyViolations(counts: {
  views: number;
  programs: number;
  fileViewers: number;
  commands: number;
  nodes: number;
}): TransparencyViolation[] {
  const out: TransparencyViolation[] = [];
  if (
    (counts.views > 0 || counts.programs > 0 || counts.fileViewers > 0) &&
    counts.commands === 0
  ) {
    out.push({
      rule: "command-surface",
      detail: `기능 보유(views=${counts.views}, programs=${counts.programs}, fileViewers=${counts.fileViewers})인데 commands=0`,
    });
  }
  if (counts.views > 0 && counts.nodes === 0) {
    out.push({
      rule: "view-nodes",
      detail: `views=${counts.views}인데 contributes.nodes=0 — ui.tree 노출 없음`,
    });
  }
  return out;
}

// ② view-status 의 판정 — 런타임 입력. 캐퍼빌리티는 코어 실존(viewRegistry PluginViewContext.setStatus
// → sessions view.status → status.query). 활성화 시점엔 뷰가 마운트 전이라 로더에서 판정 불가 —
// 시행 지점은 런타임 진단(plugin.conformance)·발행 게이트(doctor)다. 여기는 순수 판정만 둔다.
export function unreportedStatusViews(
  mountedViewIds: readonly string[],
  statusReportedViewIds: readonly string[],
): string[] {
  const reported = new Set(statusReportedViewIds);
  return mountedViewIds.filter((id) => !reported.has(id));
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
// C2 와 같은 결로 warn 출발(신설 축 — 스키마가 필드를 싣기 전이라 설치본 실측이 아직 없다).
// blocking 승격은 스키마 랜딩 후 위반 0 실측 유지 + 명시 재입법 커밋으로만 한다(C4·C5 —
// 무언 승격·무언 완화 둘 다 금지). conformance.test.ts 의 핀 테스트가 동행 개정을 강제한다.

export type ImplementsRule =
  | "implements-shape"
  | "implements-grammar"
  | "implements-duplicate";

export const C3_ENFORCEMENT: Readonly<Record<ImplementsRule, EnforcementMode>> = {
  "implements-shape": "warn",
  "implements-grammar": "warn",
  "implements-duplicate": "warn",
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
