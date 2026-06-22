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
export function collectExposed(): ScannedNode[] {
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
      "Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Use to discover addressable targets before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable.",
    triggers: { ko: "DOM 트리 주소목록 노드목록 ui트리" },
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
      "Measure an exposed node — returns its viewport rect (px) and key computed style values. Use for pixel-alignment diagnostics. Accepts structural addresses from ui.tree only; CSS selectors are rejected.",
    triggers: { ko: "DOM 측정 레이아웃 rect 크기 스타일" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
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
      "Dispatch a click event to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Unexposed addresses return NOT_EXPOSED — no guessing.",
    triggers: { ko: "클릭 주입 ui클릭 버튼클릭 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
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

  register("ui.input.fill", {
    description:
      "Set the value of an exposed input/textarea node and dispatch input+change events (E2E injection). Uses the native value setter so React controlled inputs pick the value up. Unexposed addresses return NOT_EXPOSED.",
    triggers: { ko: "입력 주입 값입력 텍스트입력 폼입력 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      value: { type: "string", description: "Value to set into the field", required: true },
    },
    returns: "{ filled, address }",
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'sok ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
    ],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement)
      )
        return { ok: false as const, code: "INVALID_PARAMS", message: `입력 노드 아님: ${addr}` };
      // React controlled input 은 .value 직접 할당을 덮어쓴다 — prototype 의 native setter 로 넣어야 onChange 가 먹는다.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, p.value as string);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, address: addr };
    },
  });

  register("ui.input.drag", {
    description:
      "Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup over `to`) — drives drag-merge UIs (content/sidebar tabs). zone picks the point within the target rect: center (default), left/right/top/bottom (edge, for directional split). from==to + zone=center = a plain click (mousedown/mouseup, no move). Unexposed addresses return NOT_EXPOSED.",
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: "Source node address (the tab/element to grab)", required: true },
      to: { type: "string", description: "Target node address (drop onto)", required: true },
      zone: {
        type: "string",
        description: "center | left | right | top | bottom — point within the target rect",
        enum: ["center", "left", "right", "top", "bottom"],
      },
    },
    returns: "{ dragged, from, to, zone }",
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'sok ui.input.drag \'{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}\'',
    ],
    handler: (p) => {
      const fromEl = resolveElement(p.from as string);
      if (!fromEl) return notExposed(p.from as string);
      const toEl = resolveElement(p.to as string);
      if (!toEl) return notExposed(p.to as string);
      const fr = fromEl.getBoundingClientRect();
      const tr = toEl.getBoundingClientRect();
      const fromPt = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
      const zone = (p.zone as string) ?? "center";
      // zone → 타겟 rect 내 지점. 가장자리는 분할(컨텐츠/사이드바 hitTest 의 ¼ 경계 안쪽).
      const zx =
        zone === "left" ? 0.08 : zone === "right" ? 0.92 : 0.5;
      const zy =
        zone === "top" ? 0.12 : zone === "bottom" ? 0.88 : 0.5;
      const toPt = { x: tr.left + tr.width * zx, y: tr.top + tr.height * zy };
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, view: window }),
        );
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      fire("mousedown", fromPt.x, fromPt.y, fromEl);
      // 근접(같은 지점)이면 순수 클릭 — mousemove 없이 mouseup(드래그 임계 미만 = 탭 전환 등).
      if (dist >= 5) {
        const mid = { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 };
        fire("mousemove", mid.x, mid.y, window);
        fire("mousemove", toPt.x, toPt.y, window);
      }
      fire("mouseup", toPt.x, toPt.y, window);
      return { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone };
    },
  });
}
