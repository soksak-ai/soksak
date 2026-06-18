// DOM 주소 — 구조적 path 의 단일 진실(순수, I/O 0). 임의 CSS selector 를 대체한다.
//
// 결정(중복/멱등/규칙): id 체계는 카운터 id(t1,g1) 재실행 변동(비멱등)·멀티윈도우 중복·요소 id 전역유일
// 부담으로 부적합. path + 안정 세그먼트 — 세그먼트는 카운터 id 가 아니라 안정 식별자(root/alias·region·
// 위치인덱스/active·qualifiedViewId·노드path). 계층 경로가 유일(중복0), 안정 세그먼트가 멱등(재실행 일관),
// 구조가 곧 규칙(이 모듈이 유일 출처 — inline 파싱 금지).
//
// 문법:
//   호스트 뷰:   win/<label>/proj/<root|alias>/<region>/pane/<idx|active>/view/<pluginId.viewId>/node/<nodePath>
//   호스트 크롬:  win/<label>/chrome/<chromePath>
//   region ∈ { left | content | right }
// 생략 = 활성: win 생략 = 현재 창, proj 생략 = 활성 프로젝트, pane 생략 = 활성 pane. 멱등(활성 기준 일관).
// node/<nodePath> 와 chrome/<chromePath> 는 슬래시 포함 다중 세그먼트 허용(끝까지). 그 외는 단일 토큰.

export const REGIONS = ["left", "content", "right"] as const;
export type Region = (typeof REGIONS)[number];

// 노드/크롬 path 세그먼트 — 영숫자·하이픈·점(qualifiedViewId)·슬래시(계층)·별표(패턴은 선언용, 주소엔 인스턴스).
// 인스턴스 주소는 별표 불가. 각 세그먼트 = [a-z0-9][a-z0-9.-]* (소문자 시작), "/" 로 연결.
const SEG = /^[a-z0-9][a-z0-9.-]*$/;
export const NODE_PATH_RE = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;

export interface AddressParts {
  window?: string; // 창 label(생략=현재 창)
  // 호스트 크롬 경로(chrome/...) — 있으면 view/node 계열과 배타.
  chrome?: string;
  // 뷰 컨텍스트(chrome 이 아닐 때).
  project?: string; // root/alias(생략=활성)
  region?: Region; // left|content|right
  pane?: string; // 위치 인덱스 or "active"(생략=활성)
  view?: string; // qualifiedViewId(pluginId.viewId)
  node?: string; // 플러그인 노출 노드 path(슬래시 계층)
}

function fail(msg: string): { error: string } {
  return { error: msg };
}

// 주소 문자열 → 구조. 불량이면 { error }. selector 추측 0 — 규칙 밖 입력은 명확히 거부.
export function parseAddress(input: string): AddressParts | { error: string } {
  if (typeof input !== "string" || input.trim() === "") return fail("빈 주소");
  const segs = input.replace(/^\/+|\/+$/g, "").split("/");
  const out: AddressParts = {};
  let i = 0;

  // win/<label> (선택, 맨 앞)
  if (segs[i] === "win") {
    const label = segs[i + 1];
    if (!label || !SEG.test(label)) return fail(`win 라벨 불량: ${label ?? "(없음)"}`);
    out.window = label;
    i += 2;
  }

  if (i >= segs.length) return fail("창 뒤 경로 없음");

  // chrome/<path...> (뷰 계열과 배타)
  if (segs[i] === "chrome") {
    const rest = segs.slice(i + 1).join("/");
    if (!rest) return fail("chrome 경로 없음");
    if (!NODE_PATH_RE.test(rest)) return fail(`chrome path 불량: ${rest}`);
    out.chrome = rest;
    return out;
  }

  // proj/<id> (선택)
  if (segs[i] === "proj") {
    const id = segs[i + 1];
    if (!id) return fail("proj id 없음");
    out.project = id; // root/alias 는 임의 문자 허용(경로일 수 있음) — 단일 세그먼트로만 받는다
    i += 2;
  }

  // region (선택이나 view 앞엔 권장)
  if (i < segs.length && (REGIONS as readonly string[]).includes(segs[i])) {
    out.region = segs[i] as Region;
    i += 1;
  }

  // pane/<idx|active> (선택)
  if (segs[i] === "pane") {
    const p = segs[i + 1];
    if (!p || !(p === "active" || /^\d+$/.test(p))) return fail(`pane 불량(idx|active): ${p ?? "(없음)"}`);
    out.pane = p;
    i += 2;
  }

  // view/<pluginId.viewId> (선택)
  if (segs[i] === "view") {
    const v = segs[i + 1];
    if (!v || !SEG.test(v) || !v.includes(".")) return fail(`view 키 불량(pluginId.viewId): ${v ?? "(없음)"}`);
    out.view = v;
    i += 2;
  }

  // node/<path...> (선택, 끝까지)
  if (segs[i] === "node") {
    const rest = segs.slice(i + 1).join("/");
    if (!rest) return fail("node path 없음");
    if (!NODE_PATH_RE.test(rest)) return fail(`node path 불량: ${rest}`);
    out.node = rest;
    return out;
  }

  if (i < segs.length) return fail(`알 수 없는 세그먼트: ${segs.slice(i).join("/")}`);
  return out;
}

// 구조 → 정규 주소 문자열. parseAddress 와 왕복 항등(parse∘format=구조). 생략 필드는 경로에서 빠진다.
export function formatAddress(p: AddressParts): string {
  const segs: string[] = [];
  if (p.window) segs.push("win", p.window);
  if (p.chrome) {
    segs.push("chrome", p.chrome);
    return segs.join("/");
  }
  if (p.project) segs.push("proj", p.project);
  if (p.region) segs.push(p.region);
  if (p.pane) segs.push("pane", p.pane);
  if (p.view) segs.push("view", p.view);
  if (p.node) segs.push("node", p.node);
  return segs.join("/");
}

export function isParseError(r: AddressParts | { error: string }): r is { error: string } {
  return "error" in r;
}
