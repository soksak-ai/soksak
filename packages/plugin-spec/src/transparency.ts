// C2 정적 투명성 판정 — 결합 법칙 C2(투명성 3종: command·status·DOM)의 매니페스트-전용 규칙.
// 이 파일이 판정의 단일진실이다(순수함수 — 매니페스트 데이터만 받고 런타임 증거를 받지 않는다).
// 강제는 소비 경계 몫: 코어 로더(활성화 거부/경고)·plugin.conformance(진단)·
// scripts/gates/c2-transparency-scan.mjs(설치본 게이트)·bin/validate.mjs(저자 게이트)가
// 전부 이 판정을 import 한다 — 판정 미러를 두지 마라(이중진실 금지).
//
// 규칙 3종(정적):
//   ① command-surface     기능 보유(views/programs/fileViewers/overlays) ∧ commands=0 → 위반
//   ② view-nodes          렌더 surface(views/overlays)>0 ∧ nodes=0 → 위반(ui.tree 부재)
//      view-nodes 규칙은 view와 overlay DOM을 함께 다룬다.
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

// 정적 규칙 시행표 — 로더·게이트·CLI가 이 표 하나를 사용한다. 세 규칙은 모두 blocking이며,
// 변경에는 버전이 붙은 계약 변경과 같은 배포 모집단을 검사하는 conformance가 필요하다.
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
  overlays: readonly unknown[];
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

// 기능 보유 술어는 렌더/프로그램 기여축 전부를 센다. overlay도 별도 sandbox document에서
// DOM을 렌더하므로 command 조작면과 nodes 주소면을 뷰와 똑같이 노출해야 한다.
export function transparencyViolations(
  c: TransparencyContributes,
): TransparencyViolation[] {
  const out: TransparencyViolation[] = [];
  if (
    (c.views.length > 0 || c.programs.length > 0 || c.fileViewers.length > 0 || c.overlays.length > 0) &&
    c.commands.length === 0
  ) {
    out.push({
      rule: "command-surface",
      detail: `기능 보유(views=${c.views.length}, programs=${c.programs.length}, fileViewers=${c.fileViewers.length}, overlays=${c.overlays.length})인데 commands=0`,
    });
  }
  if ((c.views.length > 0 || c.overlays.length > 0) && c.nodes.length === 0) {
    out.push({
      rule: "view-nodes",
      detail: `렌더 surface(views=${c.views.length}, overlays=${c.overlays.length})인데 contributes.nodes=0 — ui.tree 노출 없음`,
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
