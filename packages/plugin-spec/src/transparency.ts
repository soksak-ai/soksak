// C2 정적 투명성 판정 — 결합 법칙 C2(투명성 3종: command·status·DOM)의 매니페스트-전용 규칙.
// 이 파일이 판정의 단일진실이다(순수함수 — 매니페스트 데이터만 받고 런타임 증거를 받지 않는다).
// 강제는 소비 경계 몫: 코어 로더(활성화 거부/경고)·plugin.conformance(진단)·
// scripts/gates/c2-transparency-scan.mjs(설치본 게이트)·bin/validate.mjs(저자 게이트)가
// 전부 이 판정을 import 한다 — 판정 미러를 두지 마라(이중진실 금지).
//
// 규칙 3종(정적):
//   ① command-surface     기능 보유(views>0 ∨ programs>0 ∨ fileViewers>0) ∧ commands=0 → 위반
//   ② view-nodes          views>0 ∧ nodes=0 → 위반(ui.tree 부재 = 주소 기반 클릭 E2E 불가)
//   ③ content-view-status 콘텐츠 뷰가 status 선언 부재 → 위반(무상태 뷰는 [] 로 명시 — 침묵 불가)
// 런타임 규칙(마운트된 뷰가 선언한 코드를 실보고하는가 — view-status, 선언≡보고)은 매니페스트로
// 판정 불가라 코어(src/plugins/conformance.ts viewStatusConformance)에 남는다 — 여기는 런타임 증거 불요분만.

export type EnforcementMode = "blocking" | "warn";

export type StaticTransparencyRule =
  | "command-surface"
  | "view-nodes"
  | "content-view-status";

export interface TransparencyViolation {
  rule: StaticTransparencyRule;
  detail: string; // 위반 사실 서술(무엇이 몇 개인지) — 경고/거부 메시지에 그대로 실림
}

// 정적 규칙 시행 입법표 — 모든 소비 경계(로더·게이트·CLI)가 이 표 하나를 본다.
// blocking 승격·완화는 재입법 커밋으로만 한다(C5 — 무언 완화·무언 승격 둘 다 금지).
// 재입법 이력:
//   2026-07-11 도입 — command-surface·view-nodes 는 위반 0 실측 승격분을 승계해 blocking.
//   2026-07-11 신설 — content-view-status 는 설치본 실측 위반 잔존(dev 홈 콘텐츠 뷰 10개 전부
//     status 미선언)이라 warn 출발. 위반 0 실측 + 재입법 커밋으로 blocking 승격한다(래칫 —
//     command-surface·view-nodes 가 밟은 같은 경로).
//   2026-07-11 승격 — 콘텐츠 뷰 10개 전부 선언 도달(보고 뷰 6=실측 코드, 무상태 뷰 4=[] 명시,
//     c2-transparency-scan 위반 0 실측) 후 content-view-status 를 blocking 으로 승격.
//   2026-07-12 모집단 정정 — 위 승격의 0-실측이 dev-home(로컬 작업 사본)만 봤다. 배포·설치는
//     GitHub 를 통하고 배포 게이트(registry update.sh)는 카탈로그 모집단을 시행하는데, 로컬이
//     public 보다 앞선(적합화 커밋 미push) 사이 카탈로그된 14종이 public 에서 content-view-status
//     를 안은 채 blocking 이 시행돼 배포 게이트가 그들을 드롭했다. 정정: (a) 14종 public 적합화
//     반영으로 배포 모집단 0 도달, (b) 승격 권위 게이트를 배포 모집단(라이브 registry.json 의
//     카탈로그된 플러그인의 GitHub 매니페스트)으로 이동 — c2-transparency-scan --registry
//     (make gates-registry). 규칙: C2 규칙 blocking 승격은 "배포 모집단 0 실측"이 기계 조건이다
//     (시행 모집단 = 측정 모집단). 로컬 --plugins 스캔은 개발 사전점검일 뿐 승격 권위가 아니다.
export const C2_STATIC_ENFORCEMENT: Readonly<
  Record<StaticTransparencyRule, EnforcementMode>
> = {
  "command-surface": "blocking",
  "view-nodes": "blocking",
  "content-view-status": "blocking",
};

// 판정 입력 — 파싱된 매니페스트 contributes 의 구조 부분집합. PluginManifest["contributes"] 가
// 그대로 대입된다(구조 타이핑). counts 가 아니라 실물 선언 배열을 받는다 — 규칙 ③ 이 뷰별
// placements·status 를 봐야 하기 때문(집계 열화 금지).
export interface TransparencyView {
  id: string;
  placements: readonly string[];
  status?: readonly string[];
}

export interface TransparencyContributes {
  views: readonly TransparencyView[];
  commands: readonly unknown[];
  fileViewers: readonly unknown[];
  programs: readonly unknown[];
  nodes: readonly unknown[];
}

// 콘텐츠 뷰 판별 — placements 에 "content" 포함. 설치본 매니페스트 실측으로 확정한 정의다
// (dev 홈 40개 실측: 콘텐츠 뷰는 전부 placements 로 식별되고 별도 표식이 없다. content 단독 9,
// sidebar 혼합 1 — 혼합도 콘텐츠 탭에 실리므로 콘텐츠 뷰다). setStatus 는 콘텐츠 배치에서만
// 유효(사이드바 no-op)라 status 선언 의무의 스코프가 이 판별과 일치한다.
export function isContentView(view: { placements: readonly string[] }): boolean {
  return view.placements.includes("content");
}

// 기능 보유 술어는 세 기여축(뷰·프로그램·파일 뷰어) 전부를 센다 — 파일 뷰어만 기여하는
// 플러그인(콘텐츠로 파일을 여는 렌더러)도 command 로 조회·조작면을 노출해야 한다.
export function transparencyViolations(
  c: TransparencyContributes,
): TransparencyViolation[] {
  const out: TransparencyViolation[] = [];
  if (
    (c.views.length > 0 || c.programs.length > 0 || c.fileViewers.length > 0) &&
    c.commands.length === 0
  ) {
    out.push({
      rule: "command-surface",
      detail: `기능 보유(views=${c.views.length}, programs=${c.programs.length}, fileViewers=${c.fileViewers.length})인데 commands=0`,
    });
  }
  if (c.views.length > 0 && c.nodes.length === 0) {
    out.push({
      rule: "view-nodes",
      detail: `views=${c.views.length}인데 contributes.nodes=0 — ui.tree 노출 없음`,
    });
  }
  const undeclared = c.views.filter((v) => isContentView(v) && v.status === undefined);
  if (undeclared.length > 0) {
    out.push({
      rule: "content-view-status",
      detail: `콘텐츠 뷰 ${undeclared.length}개가 status 선언 부재: ${undeclared
        .map((v) => v.id)
        .join(", ")} — 보고 상태 코드 목록(무상태면 [])을 contributes.views[].status 로 명시하라`,
    });
  }
  return out;
}
