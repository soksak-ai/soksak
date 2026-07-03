// 보더 소유권 계약 테이블 — 기계 진실(사람 헌법은 docs/UI.md §B1~B7).
// "어떤 DOM 의 어느 변에 어떤 토큰의 1px 선이 있어야 하는가"를 선언한다.
//   - 소비자: 런타임 검증기(ui.validate/ui.expect — borderValidate.ts)와
//     정적 게이트(cssContract.test.ts).
//   - 여기 없는 변은 판정하지 않는다. "none" 은 "반드시 선이 없어야 함"의 단언.
//   - when 조건은 루트 data-*(테마 엔진이 chrome 토큰을 주입)으로 평가한다.
//   - 테이블 수정 = 기준 수정이다. 통과를 위해 고치지 말 것(배신 금지) —
//     기준이 틀렸으면 docs/UI.md 의 해당 조항부터 정정하라.

export type EdgeName = "top" | "right" | "bottom" | "left";
export const EDGE_NAMES: readonly EdgeName[] = ["top", "right", "bottom", "left"];

// bd = 앱 크롬/외곽/떠 있는 표면, bd-soft = 패널 내부선(§B4), none = 선 금지 단언.
export type EdgeExpect = "bd" | "bd-soft" | "none";

// 루트 data-* 조건(테마 chrome 토큰). 나열된 값일 때만 규칙 활성.
// (기준 정정 2026-06-12: tabBar/titlebar 의 "transparent" 는 배경 전용 토큰 —
// 선의 소유/표시와 무관함이 라이브 검증으로 확인돼 when 축에서 제거.)
export interface RuleWhen {
  paneStyle?: readonly string[]; // data-pane-style
  divider?: readonly string[]; // data-divider
}

export interface BorderRule {
  id: string;
  selector: string;
  // kind "edges": 4변 보더 판정. kind "seam": 경계 도구의 1px 중앙선(§B6 예외) —
  // solid 면 배경 그라데이션에 토큰 색 존재, overlay 면 휴면 완전 투명을 단언.
  kind: "edges" | "seam";
  edges?: Partial<Record<EdgeName, EdgeExpect>>;
  seam?: "bd-soft" | "rest-transparent";
  when?: RuleWhen;
  note: string; // 근거 조항(§B…) 의무
}

export const BORDER_RULES: readonly BorderRule[] = [
  // ── B1 외곽 전속 ──────────────────────────────────────────────────────────
  // 조건부 표면은 상태 공간을 빈틈 없이 커버해야 한다(§B8 전수성 게이트):
  // "존재해야 하는 상태"와 "존재하면 안 되는 상태"를 모두 단언한다.
  {
    id: "perimeter-frame",
    selector: ".egroup-frame",
    kind: "edges",
    edges: { top: "bd", right: "bd", bottom: "bd", left: "bd" },
    when: { paneStyle: ["card", "floating"] },
    note: "§B1 — 패널 외곽 4변은 프레임 전속",
  },
  {
    id: "perimeter-frame-flat",
    selector: ".egroup-frame",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    when: { paneStyle: ["flat"] },
    note: "§B1 보수 — flat 은 프레임 무선(존재하면 안 되는 상태의 단언)",
  },

  // ── B3 앱 크롬(카드 영역 바깥) — 본문에서 먼 쪽이 소유, 톤 bd ─────────────
  {
    id: "titlebar-bottom",
    selector: ".titlebar",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 타이틀바가 하단 경계 소유(배경 토큰과 무관)",
  },
  {
    id: "content-tabs-bottom",
    selector: ".content-tabs:not(.vertical)",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 컨텐츠 탭 밴드가 하단 경계 소유",
  },
  {
    id: "ft-header-bottom",
    selector: ".ft-header",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 좌측 트리 헤더가 하단 경계 소유",
  },
  {
    id: "plugin-side-head-bottom",
    selector: ".plugin-side-head",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 우측 사이드바 헤더가 하단 경계 소유",
  },
  {
    id: "plugin-side-status-top",
    selector: ".plugin-side-status",
    kind: "edges",
    edges: { top: "bd" },
    note: "§B2 — 우측 사이드바 푸터가 본문과의 경계 소유(top)",
  },
  {
    id: "left-host-tabs-bottom",
    selector: ".left-host-tabs",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 좌측 호스트 탭 스트립이 하단 경계 소유",
  },

  // ── B2 세로 크롬 — 본문 쪽 변 소유, 톤 bd ─────────────────────────────────
  {
    id: "sidebar-right-edge",
    selector: ".sidebar",
    kind: "edges",
    edges: { right: "bd" },
    note: "§B2 — 좌측 사이드바는 right 소유",
  },
  {
    id: "sidebar-right-left-edge",
    selector: ".sidebar-right",
    kind: "edges",
    edges: { left: "bd" },
    note: "§B2 — 우측 사이드바는 left 소유",
  },
  {
    id: "plugin-rail-right",
    selector: ".plugin-rail",
    kind: "edges",
    edges: { right: "bd" },
    note: "§B2 — 플러그인 아이콘 레일은 right 소유",
  },
  {
    id: "project-rail-right",
    selector: ".project-rail",
    kind: "edges",
    edges: { right: "bd" },
    note: "§B2/B6 — 레일이 right 소유(리사이저의 선 소유 금지)",
  },

  // ── B2 패널 내부선 — 크롬 밴드가 본문 쪽 변 소유, 톤 bd-soft ──────────────
  {
    id: "view-tabs-bottom",
    selector: ".view-tabs-wrap",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 패널 헤더(탭 모드)가 본문과의 경계 소유",
  },
  {
    id: "egroup-title-bottom",
    selector: ".egroup-title",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 패널 헤더(타이틀 모드)가 본문과의 경계 소유",
  },
  {
    id: "egroup-status-top",
    selector: ".egroup-status",
    kind: "edges",
    edges: { top: "bd-soft" },
    note: "§B2 — 스테이터스바가 본문과의 경계 소유(이미지 12 결손의 정정)",
  },

  // ── B2 본문 무보더 단언 ───────────────────────────────────────────────────
  {
    id: "body-slot-none",
    selector: ".egroup-body-slot",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    note: "§B2 — 본문은 선을 소유하지 않는다",
  },

  // ── B6 경계 도구 무소유 단언 ──────────────────────────────────────────────
  {
    id: "resizer-no-line",
    selector: ".sidebar-resizer, .sidebar-right-resizer, .project-rail-resizer",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    note: "§B6 — 리사이저는 선을 소유하지 않는다",
  },

  // ── B6 예외: 불투명 콘텐츠 사이 seam(divider 토큰 소비) ───────────────────
  {
    id: "pane-seam-solid",
    selector: ".pane-resize-handle",
    kind: "seam",
    seam: "bd-soft",
    when: { divider: ["solid"] },
    note: "§B6 예외 — solid 테마에서 도구가 1px 중앙선 표시(소유 위임)",
  },
  {
    id: "pane-seam-overlay",
    selector: ".pane-resize-handle",
    kind: "seam",
    seam: "rest-transparent",
    when: { divider: ["overlay"] },
    note: "§B6 — overlay 테마에서 휴면 완전 투명(hover 강조만)",
  },
  {
    id: "group-seam-solid",
    selector: ".egroup-divider",
    kind: "seam",
    seam: "bd-soft",
    when: { divider: ["solid"] },
    note: "§B6 예외 — 그룹 분할 seam 도 동일",
  },
  {
    id: "group-seam-overlay",
    selector: ".egroup-divider",
    kind: "seam",
    seam: "rest-transparent",
    when: { divider: ["overlay"] },
    note: "§B6",
  },

  // ── 패널 내부 보조 밴드(B2, 톤 bd-soft) ──────────────────────────────────
  {
    id: "bv-bar-bottom",
    selector: ".bv-bar",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 브라우저 URL 바가 본문(webview)과의 경계 소유",
  },
  {
    id: "bv-bm-list-bottom",
    selector: ".bv-bm-list",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 즐겨찾기 드롭다운이 본문과의 경계 소유",
  },
  {
    id: "fv-toolbar-bottom",
    selector: ".fv-toolbar",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 파일 뷰어 툴바가 본문과의 경계 소유",
  },
  {
    id: "fv-banner-bottom",
    selector: ".fv-banner",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 파일 배너가 본문과의 경계 소유",
  },

  // ── 세로 모드 컨텐츠 탭(설정 조건 — 부재 시 매치 0으로 자연 skip) ─────────
  {
    id: "content-tabs-vertical-right",
    selector: ".content-tabs.vertical",
    kind: "edges",
    edges: { right: "bd" },
    note: "§B2 — 좌측 세로 탭 스트립은 right 소유",
  },

  // ── 떠 있는 표면(B4 톤 bd) ────────────────────────────────────────────────
  {
    id: "float-surfaces",
    selector: ".dmodal-card, .ctab-menu, .ctab-submenu, .cm-find",
    kind: "edges",
    edges: { top: "bd", right: "bd", bottom: "bd", left: "bd" },
    note: "§B4 — 떠 있는 표면은 4변 bd",
  },
  {
    id: "dmodal-head-bottom",
    selector: ".dmodal-head",
    kind: "edges",
    edges: { bottom: "bd" },
    note: "§B3 — 모달 헤더가 본문과의 경계 소유",
  },

  // ── 설정 모달 2-pane 내부선(B2, 톤 bd-soft) ──────────────────────────────
  {
    id: "settings-nav-right",
    selector: ".settings-nav",
    kind: "edges",
    edges: { right: "bd-soft" },
    note: "§B2 — 설정 좌측 내비가 본문 패널과의 경계 소유(모달 내부선)",
  },
  {
    id: "settings-row-bottom",
    selector: ".settings-row",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "§B2 — 설정 항목 행의 하단 구분선(패널 내부 리스트 분리)",
  },

  // ── 오케스트레이터 창(A3) 내부선 — 헤더/맵/콘솔이 각자 경계 소유 ──────────
  {
    id: "orch-header-bottom",
    selector: ".orch-header",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: "A3 — 오케스트레이터 헤더가 본문과의 경계 소유",
  },
  {
    id: "orch-map-right",
    selector: ".orch-map",
    kind: "edges",
    edges: { right: "bd-soft" },
    note: "A3 — 창·모니터 맵이 피드와의 세로 경계 소유",
  },
  {
    id: "orch-console-top",
    selector: ".orch-console",
    kind: "edges",
    edges: { top: "bd-soft" },
    note: "A3 — 명령 콘솔이 본문과의 경계 소유",
  },
];
