// 분할 레이아웃 + 드롭 히트테스트 — 콘텐츠 영역(GroupArea)과 좌측 사이드바(LeftSidebarHost)가
// 공유하는 단일 머신. SplitTree<L> 를 % 좌표 셀 + 분할 경계(divider)로 펼치고, 포인터 → 드롭존(5존)
// 을 계산한다. [RULE] 두 영역이 동일하게 동작해야 하므로 레이아웃·히트테스트는 여기 하나뿐(중복 금지).

import type { SplitTree } from "../state/splitTree";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutCell<L> {
  value: L;
  rect: Rect; // 컨테이너 기준 %
}

export interface LayoutDivider {
  splitId: string;
  dir: "row" | "col";
  index: number;
  rect: Rect;
  spanPct: number;
  sizes: number[];
}

// 드롭존 — center=이동(탭 합류), 나머지=해당 방향 분할.
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

// SplitTree → 셀(% 좌표) + 분할 경계. row=가로 분할, col=세로 분할. (GroupArea.computeLayout 일반화.)
export function computeSplitLayout<L>(node: SplitTree<L>): {
  cells: LayoutCell<L>[];
  dividers: LayoutDivider[];
} {
  const cells: LayoutCell<L>[] = [];
  const dividers: LayoutDivider[] = [];
  const walk = (n: SplitTree<L>, r: Rect) => {
    if (n.type === "leaf") {
      cells.push({ value: n.value, rect: r });
      return;
    }
    if (n.dir === "row") {
      let x = r.left;
      n.children.forEach((c, i) => {
        const w = r.width * n.sizes[i];
        walk(c, { left: x, top: r.top, width: w, height: r.height });
        x += w;
        if (i < n.children.length - 1) {
          dividers.push({
            splitId: n.id,
            dir: "row",
            index: i,
            rect: { left: x, top: r.top, width: 0, height: r.height },
            spanPct: r.width,
            sizes: n.sizes,
          });
        }
      });
    } else {
      let y = r.top;
      n.children.forEach((c, i) => {
        const h = r.height * n.sizes[i];
        walk(c, { left: r.left, top: y, width: r.width, height: h });
        y += h;
        if (i < n.children.length - 1) {
          dividers.push({
            splitId: n.id,
            dir: "col",
            index: i,
            rect: { left: r.left, top: y, width: r.width, height: 0 },
            spanPct: r.height,
            sizes: n.sizes,
          });
        }
      });
    }
  };
  walk(node, { left: 0, top: 0, width: 100, height: 100 });
  return { cells, dividers };
}

// 포인터(clientX/Y) + 컨테이너 rect → 어느 셀의 어느 zone. (GroupArea.hitTest 일반화.)
// chromeTop=헤더(탭 줄) px, statusPx=상태바 px — 본문 영역(가장자리 ¼ 분할판정)을 정한다.
// selfCenterOnly=true 면 자기 출발 셀 위에선 항상 center(자기 분할 금지). idOf=셀 식별자.
export function hitTestCells<L>(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  cells: LayoutCell<L>[],
  idOf: (v: L) => string,
  opts: {
    chromeTop: number;
    statusPx: number;
    sourceId?: string;
    selfCenterOnly?: boolean;
  },
): { id: string; zone: DropZone } | null {
  const r = containerRect;
  const xPct = ((clientX - r.left) / r.width) * 100;
  const yPct = ((clientY - r.top) / r.height) * 100;
  const cell = cells.find(
    (c) =>
      xPct >= c.rect.left &&
      xPct <= c.rect.left + c.rect.width &&
      yPct >= c.rect.top &&
      yPct <= c.rect.top + c.rect.height,
  );
  if (!cell) return null;
  const id = idOf(cell.value);
  // 자기 출발 셀 위: selfCenterOnly 면 분할 무의미 → center.
  if (id === opts.sourceId && opts.selfCenterOnly) {
    return { id, zone: "center" };
  }
  const cellTopPx = r.top + (cell.rect.top / 100) * r.height;
  const cellHpx = (cell.rect.height / 100) * r.height;
  const cellLeftPx = r.left + (cell.rect.left / 100) * r.width;
  const cellWpx = (cell.rect.width / 100) * r.width;
  const localY = clientY - cellTopPx;
  const bodyTop = opts.chromeTop;
  const bodyBottom = cellHpx - opts.statusPx;
  if (localY < bodyTop || localY > bodyBottom || bodyBottom <= bodyTop) {
    return { id, zone: "center" };
  }
  const px = (clientX - cellLeftPx) / cellWpx;
  const py = (localY - bodyTop) / (bodyBottom - bodyTop);
  const edge = 0.25;
  if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) {
    return { id, zone: "center" };
  }
  const dl = px;
  const dr = 1 - px;
  const dt = py;
  const db = 1 - py;
  const m = Math.min(dl, dr, dt, db);
  const zone: DropZone =
    m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
  return { id, zone };
}

// 셀 좌표 → CSS 변수 4개(--l/--t/--w/--h). 산수는 CSS 단일 규칙(.drop-ind-wrap 등) 소유.
export function cellVars(rect: Rect): Record<string, string> {
  return {
    "--l": `${rect.left}%`,
    "--t": `${rect.top}%`,
    "--w": `${rect.width}%`,
    "--h": `${rect.height}%`,
  };
}
