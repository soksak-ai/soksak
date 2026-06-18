// ui.* DOM 주소 명령 — 구조적 path 주소로 DOM 을 조회/측정/조작한다(임의 selector 금지).
//
// 단일 진실: 주소 문법은 address.ts, 노드 수집은 nodeScan.ts. 여기는 그 둘을 소켓 명령으로 노출.
//  - ui.tree:        노출된 DOM 주소 트리(뷰 컨테이너 [data-node] + 호스트 크롬 [data-node]).
//  - ui.measure:     주소 → 요소 rect + computed style(레이아웃 진단). selector 거부(주소만).
//  - ui.input.click: 주소 → 요소 click 디스패치(danger:inject). 불일치 = NOT_EXPOSED.
// 노출(data-node)되지 않은 요소는 주소 트리에 없어 접근 불가 → 명확한 에러(추측 0).

import { currentWindowLabel } from "../lib/webviewLabels";
import { parseAddress, isParseError } from "./address";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";

const notExposed = (addr: string) => ({
  ok: false as const,
  code: "NOT_EXPOSED" as const,
  message: `노출되지 않은 주소(접근 불가): ${addr}`,
});

// 현재 창의 노출 노드 전부를 절대 주소로 수집한다(뷰 컨테이너 + 호스트 크롬). DOM 직접 순회.
function collectExposed(): ScannedNode[] {
  const out: ScannedNode[] = [];
  const win = currentWindowLabel();
  // 뷰 컨테이너 — data-view-addr(<region>/view/<viewKey>) 를 baseAddress 로. win 접두는 현재 창.
  for (const c of document.querySelectorAll<HTMLElement>(".plugin-view-container[data-view-addr]")) {
    const base = c.dataset.viewAddr ?? "";
    if (!base) continue;
    out.push(...scanNodes(c, `win/${win}/${base}`));
  }
  // 호스트 크롬 — 뷰 컨테이너 밖의 [data-node]. 주소 = win/<label>/chrome/<nodePath>.
  for (const el of document.querySelectorAll<HTMLElement>("[data-node]")) {
    if (el.closest(".plugin-view-container")) continue; // 뷰 노드는 위에서 처리
    const nodePath = el.dataset.node ?? "";
    if (!nodePath) continue;
    out.push({ address: `win/${win}/chrome/${nodePath}`, nodePath, el });
  }
  return out;
}

// 주소 → 단일 요소 resolve. 정규화(parse∘format) 한 주소로 매칭(생략형/정규형 일치). 없으면 null.
function resolveElement(addressStr: string): HTMLElement | null {
  const parsed = parseAddress(addressStr);
  if (isParseError(parsed)) return null;
  const exposed = collectExposed();
  // 정확 일치 우선. 입력 주소에 win 생략 시 현재 창으로 보정해 비교.
  const want = addressStr.replace(/^\/+|\/+$/g, "");
  const wantWithWin = want.startsWith("win/") ? want : `win/${currentWindowLabel()}/${want}`;
  return (
    exposed.find((n) => n.address === want || n.address === wantWithWin)?.el ?? null
  );
}

export function registerDomCatalog(): void {
  register("ui.tree", {
    description:
      "노출된 DOM 주소 트리 — 플러그인 뷰가 data-node 로 노출한 노드 + 호스트 크롬 노드의 절대 주소 목록. 임의 selector 가 아닌 구조적 주소로만 접근(노출 안 된 요소는 여기 없음 = 접근 불가)",
    params: {},
    returns: "{ window, count, nodes: [{ address, nodePath }] }",
    examples: ["sok ui.tree"],
    handler: () => {
      const nodes = collectExposed().map((n) => ({ address: n.address, nodePath: n.nodePath }));
      return { window: currentWindowLabel(), count: nodes.length, nodes };
    },
  });

  register("ui.measure", {
    description:
      "DOM 주소 측정 — 노출 노드의 rect(뷰포트 px)와 핵심 computed style. 픽셀 정렬 진단용. 주소(ui.tree)로만 — selector 금지",
    params: {
      address: { type: "string", description: "노출 노드 주소(ui.tree 의 address)", required: true },
    },
    returns: "{ address, rect:{x,y,w,h}, style }",
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['sok ui.measure \'{"address":"content/view/soksak-plugin-acp-studio.studio/node/send"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        address: addr,
        rect: {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
        },
        style: {
          display: cs.display,
          height: cs.height,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          borderTop: cs.borderTopWidth,
          borderBottom: cs.borderBottomWidth,
          fontSize: cs.fontSize,
          alignItems: cs.alignItems,
          alignSelf: cs.alignSelf,
        },
      };
    },
  });

  register("ui.input.click", {
    description:
      "DOM 주소 클릭 주입(흐름 E2E) — 노출 노드(ui.tree)에 click 디스패치. 노출 안 된 주소는 NOT_EXPOSED(추측 0)",
    params: {
      address: { type: "string", description: "노출 노드 주소", required: true },
    },
    returns: "{ clicked, address }",
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['sok ui.input.click \'{"address":"win/main/chrome/modal/consent/agree"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      el.click();
      return { clicked: true, address: addr };
    },
  });
}
