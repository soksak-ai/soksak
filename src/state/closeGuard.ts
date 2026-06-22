// 닫기 가드 — 뷰 status 의 blocking 판정(R2). 순수함수, IO 0 — 닫기 위험의 단일 진실.
// 닫기 오케스트레이션(확인창·closeView 호출)은 UI 가 이 함수를 써서 한다(R6/§5).
import type { View, ContentArea, GroupNode } from "./sessions";

// 표준 blocking 어휘(R2) — 이 code 만 닫기 가드를 발동한다. 그 외 code 는 표시 전용.
// 새 blocking 의미가 필요하면 이 어휘 확장은 코어 변경을 거친다(의도적 게이트).
export const STATUS_BLOCKING = ["dirty", "busy", "running"] as const;

// 뷰가 지금 닫기 위험이면 그 이유(message ?? code), 아니면 null.
// code 가 blocking 집합에 없거나 status 미보고면 null(즉시 닫힘 가능).
export function viewCloseReason(view: View): string | null {
  const s = view.status;
  if (!s) return null;
  if (!(STATUS_BLOCKING as readonly string[]).includes(s.code)) return null;
  return s.message ?? s.code;
}

// 콘텐츠(분할 그리드) 안의 모든 뷰 중 닫기 위험한 것들의 이유 모음. 빈 배열 = 가드 없음.
export function contentCloseReasons(content: ContentArea): string[] {
  const out: string[] = [];
  for (const v of viewsOfGroupNode(content.layout)) {
    const r = viewCloseReason(v);
    if (r) out.push(r);
  }
  return out;
}

// 그룹 트리(leaf/split) 안의 모든 뷰를 순서대로 — contentCloseReasons 가 쓴다.
export function* viewsOfGroupNode(node: GroupNode): Generator<View> {
  if (node.type === "leaf") {
    yield* node.group.views;
  } else {
    for (const child of node.children) yield* viewsOfGroupNode(child);
  }
}
