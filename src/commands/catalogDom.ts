// ui.* DOM 주소 명령 — 구조적 path 주소로 DOM 을 조회/측정/조작한다(임의 selector 금지).
//
// 단일 진실: 주소 문법은 address.ts, 노드 수집은 nodeScan.ts. 여기는 그 둘을 소켓 명령으로 노출.
//  - ui.tree:        노출된 DOM 주소 트리(뷰 컨테이너 [data-node] + 호스트 크롬 [data-node]).
//  - ui.measure:     주소 → 요소 rect + computed style(레이아웃 진단). selector 거부(주소만).
//  - ui.input.click: 주소 → 요소 click 디스패치(danger:inject). 불일치 = NOT_EXPOSED.
// 노출(data-node)되지 않은 요소는 주소 트리에 없어 접근 불가 → 명확한 에러(추측 0).

import { invoke } from "@tauri-apps/api/core";
import { currentWindowLabel } from "../lib/webviewLabels";
import { parseAddress, isParseError } from "./address";
import { scanNodes, type ScannedNode } from "../plugins/nodeScan";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { viewFocusSnapshot } from "../plugins/viewFocus";

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
  const matches = exposed.filter((n) => n.address === want || n.address === wantWithWin);
  if (matches.length === 0) return null;
  // 같은 주소가 여러 요소에 붙을 수 있다(시트마다 반복되는 크롬 노드 — 뷰 탭바 등). 파킹된
  // (화면 밖 translateX) 복제를 잡으면 클릭/측정이 보이지 않는 요소로 가서 "동작 없음"이 된다
  // (실측: 탭 클릭 E2E 가 비활성 시트의 탭을 눌렀다). 사용자가 보는 요소 — 뷰포트와 교차하고
  // 크기가 있는 것 — 를 우선하고, 보이는 게 없으면 첫 매치(기존 동작)로 폴백한다.
  const visible = matches.find((n) => {
    const r = n.el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < window.innerWidth &&
      r.top < window.innerHeight
    );
  });
  return (visible ?? matches[0]).el;
}

export function registerDomCatalog(): void {
  register("ui.tree", {
    description:
      "Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Use to discover addressable targets before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable. Pass rects:true to include each node's viewport rect for coordinate work (drags, precision clicks).",
    triggers: { ko: "DOM 트리 주소목록 노드목록 ui트리" },
    params: {
      rects: {
        type: "boolean",
        description: "Include each node's viewport rect {x,y,w,h} (px)",
        default: false,
      },
    },
    returns: "{ window, count, nodes: [{ address, nodePath, rect? }] }",
    message: (d) => tmsg("msg.ui.tree", { n: Number(d.count ?? 0) }),
    examples: ["ui.tree", 'ui.tree \'{"rects":true}\''],
    handler: (p) => {
      const withRects = p.rects === true;
      const nodes = collectExposed().map((n) => {
        if (!withRects) return { address: n.address, nodePath: n.nodePath };
        const r = n.el.getBoundingClientRect();
        return {
          address: n.address,
          nodePath: n.nodePath,
          rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        };
      });
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
    message: (d) =>
      tmsg("msg.ui.measure", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
      }),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['ui.measure \'{"address":"content/view/soksak-plugin-<id>.<view>/node/send"}\''],
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

  register("ui.slot", {
    description:
      "Measure a content view's slot rectangle — the bare host container a view renders into (viewport px + devicePixelRatio). Use so an engine plugin learns its present-target rect (device px = css px * dpr) to align a native/offscreen surface, and so AI can verify placement. Address is a VIEW container (no /node): win/<label>/<region>/view/<pluginId.viewId>. Unexposed returns NOT_EXPOSED.",
    triggers: { ko: "슬롯 뷰컨테이너 rect present타깃 dpr 측정" },
    params: {
      address: {
        type: "string",
        description: "View container address (win/<label>/<region>/view/<pluginId.viewId>, no node)",
        required: true,
      },
    },
    returns: "{ address, rect:{x,y,w,h}, dpr }",
    message: (d) =>
      tmsg("msg.ui.slot", {
        w: Number((d.rect as { w?: number })?.w ?? 0),
        h: Number((d.rect as { h?: number })?.h ?? 0),
        dpr: Number(d.dpr ?? 1),
      }),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['ui.slot \'{"address":"win/main/content/view/soksak-plugin-<id>.<view>"}\''],
    handler: (p) => {
      const addr = (p.address as string) ?? "";
      const want = addr.replace(/^\/+|\/+$/g, "");
      const win = currentWindowLabel();
      const wantWithWin = want.startsWith("win/") ? want : `win/${win}/${want}`;
      // 뷰 컨테이너를 base 주소(collectExposed 와 동일 생성 규칙)로 매칭 — node 없는 view 주소.
      for (const c of document.querySelectorAll<HTMLElement>(
        ".plugin-view-container[data-view-addr]",
      )) {
        const base = c.dataset.viewAddr ?? "";
        if (!base) continue;
        const full = `win/${win}/${base}`;
        if (full === wantWithWin || full === want) {
          const r = c.getBoundingClientRect();
          return {
            address: addr,
            rect: {
              x: +r.x.toFixed(2),
              y: +r.y.toFixed(2),
              w: +r.width.toFixed(2),
              h: +r.height.toFixed(2),
            },
            dpr: window.devicePixelRatio,
          };
        }
      }
      return notExposed(addr);
    },
  });

  register("ui.focus.state", {
    description:
      "Return the keyboard-focus owner through the public view-host boundary: the requested view, whether its provider is mounted/delivered, and the view containing document.activeElement. Use after real-device input to verify that focus settled in the intended view without querying plugin-private DOM.",
    triggers: { ko: "키보드 포커스 소유자 활성 뷰 포커스 상태" },
    params: {},
    returns:
      "{ requestedViewId, mounted, delivered, activeViewId, settled, activeElement }",
    message: (d) =>
      tmsg("msg.ui.focus.state", {
        view: String(d.activeViewId ?? "none"),
      }),
    examples: ["ui.focus.state"],
    handler: () => {
      const request = viewFocusSnapshot();
      const active = document.activeElement;
      const host =
        active instanceof Element
          ? active.closest<HTMLElement>(
              ".plugin-view-container[data-pane-id]",
            )
          : null;
      const activeViewId = host?.dataset.paneId ?? null;
      return {
        ...request,
        activeViewId,
        settled:
          request.delivered && request.requestedViewId === activeViewId,
        activeElement:
          active instanceof HTMLElement
            ? {
                tag: active.tagName.toLowerCase(),
                dataNode: active.dataset.node ?? null,
                className: active.className,
              }
            : null,
      };
    },
  });

  register("ui.input.click", {
    description:
      "Dispatch a real-click sequence (mousedown → mouseup → click) to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "클릭 주입 ui클릭 버튼클릭 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
    },
    returns: "{ clicked, address }",
    message: () => tmsg("msg.ui.input.click"),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['ui.input.click \'{"address":"win/main/chrome/modal/consent/agree"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      // 실제 클릭과 등가 시퀀스 — el.click()(click 단발)은 mousedown 기반 요소(사이드바 탭
      // 드래그-선택 등)를 못 누른다. dblclick 커맨드와 동일 패턴의 1라운드.
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (const type of ["mousedown", "mouseup", "click"]) {
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, view: window }),
        );
      }
      return { clicked: true, address: addr };
    },
  });

  register("ui.input.dblclick", {
    description:
      "Dispatch a double-click (two clicks + a dblclick event) to an exposed node (E2E injection). Use to drive double-click UI flows like inline tab/label rename. Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "더블클릭 두번클릭 이름변경 rename 주입 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
    },
    returns: "{ dblclicked, address }",
    message: () => tmsg("msg.ui.input.dblclick"),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: ['ui.input.dblclick \'{"address":"win/main/chrome/tab/left/a.x"}\''],
    handler: (p) => {
      const addr = p.address as string;
      const el = resolveElement(addr);
      if (!el) return notExposed(addr);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const fire = (type: string) =>
        el.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, view: window }),
        );
      // React onDoubleClick 은 네이티브 dblclick 을 듣는다 — 두 click 으로 자연 발생하지 않으니 명시 디스패치.
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("mousedown"); fire("mouseup"); fire("click");
      fire("dblclick");
      return { dblclicked: true, address: addr };
    },
  });

  register("ui.input.fill", {
    description:
      "Set the value of an exposed input/textarea node and dispatch input+change events (E2E injection). Uses the native value setter so React controlled inputs pick the value up. Unexposed addresses return NOT_EXPOSED. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "입력 주입 값입력 텍스트입력 폼입력 E2E" },
    params: {
      address: { type: "string", description: "Exposed node address from ui.tree", required: true },
      value: { type: "string", description: "Value to set into the field", required: true },
    },
    returns: "{ filled, address }",
    message: () => tmsg("msg.ui.input.fill"),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.fill \'{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}\'',
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
      "Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone: center default, left/right/top/bottom edge for directional split), drives drag-merge tab UIs; (2) drag by a pixel delta — give `dx`/`dy` instead of `to`, grabs `from` at its center and drags that many CSS px (for resize handles / split dividers). mousemove+mouseup dispatch on window so window-level drag listeners (divider resize) receive them. Unexposed addresses return NOT_EXPOSED. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    triggers: { ko: "드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그" },
    params: {
      from: { type: "string", description: "Source node address (the tab / divider / element to grab)", required: true },
      to: { type: "string", description: "Target node address to drop onto (mode 1). Omit when using dx/dy.", required: false },
      zone: {
        type: "string",
        description: "center | left | right | top | bottom — point within the target rect (mode 1)",
        enum: ["center", "left", "right", "top", "bottom"],
      },
      dx: { type: "number", description: "Horizontal drag distance in CSS px from `from` center (mode 2 — resize/divider). Alternative to `to`.", required: false },
      dy: { type: "number", description: "Vertical drag distance in CSS px from `from` center (mode 2).", required: false },
    },
    returns: "{ dragged, from, to?, zone?, dx?, dy? }",
    message: (d) => (d.dragged ? tmsg("msg.ui.input.drag.dragged") : tmsg("msg.ui.input.drag.tap")),
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    danger: "inject",
    examples: [
      'ui.input.drag \'{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}\'',
      'ui.input.drag \'{"from":"win/main/chrome/divider/s0/0","dx":120}\'',
    ],
    handler: (p) => {
      const fromEl = resolveElement(p.from as string);
      if (!fromEl) return notExposed(p.from as string);
      const fr = fromEl.getBoundingClientRect();
      const fromPt = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
      const byDelta = p.dx != null || p.dy != null;
      let toPt: { x: number; y: number };
      if (byDelta) {
        // 모드 2 — 픽셀 델타(리사이즈 핸들/디바이더). from 중앙을 잡아 dx/dy 만큼 끈다.
        toPt = { x: fromPt.x + (Number(p.dx) || 0), y: fromPt.y + (Number(p.dy) || 0) };
      } else {
        // 모드 1 — 타겟에 드롭(탭 병합/분할).
        const toEl = resolveElement(p.to as string);
        if (!toEl) return notExposed(p.to as string);
        const tr = toEl.getBoundingClientRect();
        const zone = (p.zone as string) ?? "center";
        const zx = zone === "left" ? 0.08 : zone === "right" ? 0.92 : 0.5;
        const zy = zone === "top" ? 0.12 : zone === "bottom" ? 0.88 : 0.5;
        toPt = { x: tr.left + tr.width * zx, y: tr.top + tr.height * zy };
      }
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, view: window }),
        );
      const dist = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
      // mousedown 은 잡는 요소(divider/탭)에, move/up 은 window 에 — divider 리사이즈는 window 레벨
      // mousemove/mouseup 리스너를 onDividerDown 이 등록하므로 window 로 보내야 받는다.
      fire("mousedown", fromPt.x, fromPt.y, fromEl);
      if (dist >= 5) {
        const mid = { x: (fromPt.x + toPt.x) / 2, y: (fromPt.y + toPt.y) / 2 };
        fire("mousemove", mid.x, mid.y, window);
        fire("mousemove", toPt.x, toPt.y, window);
      }
      fire("mouseup", toPt.x, toPt.y, window);
      return byDelta
        ? { dragged: dist >= 5, from: p.from, dx: p.dx ?? 0, dy: p.dy ?? 0 }
        : { dragged: dist >= 5, click: dist < 5, from: p.from, to: p.to, zone: p.zone ?? "center" };
    },
  });

  register("ui.hit", {
    description:
      "Return the topmost DOM element at viewport x,y (tag, classes, data-* attrs, rect) — hit-test diagnostics for drag/click E2E (what would elementFromPoint see?).",
    params: {
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ tag, className, data, rect } | { tag: null }",
    message: (d) => (d.tag ? tmsg("msg.ui.hit.found", { tag: String(d.tag) }) : tmsg("msg.ui.hit.none")),
    examples: ['ui.hit \'{"x":200,"y":140}\''],
    handler: (p) => {
      const el = document.elementFromPoint(Number(p.x), Number(p.y));
      if (!(el instanceof Element)) return { tag: null };
      const r = el.getBoundingClientRect();
      // SVG 의 className 은 SVGAnimatedString — getAttribute 로 통일. 조상 체인의 데이터도 유용해
      // 가장 가까운 [data-node]/[class] 보유 HTML 조상을 closest 로 함께 보고한다.
      const host = el.closest<HTMLElement>("[data-node], button, a, [class]");
      return {
        tag: el.tagName.toLowerCase(),
        className: el.getAttribute("class") ?? "",
        data: el instanceof HTMLElement ? { ...el.dataset } : {},
        host: host
          ? { tag: host.tagName.toLowerCase(), className: host.className, data: { ...host.dataset } }
          : null,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      };
    },
  });

  // native 마우스 브릿지(App 의 native-mousedown/move/up)를 소켓으로 구동 — 브라우저(네이티브 child)
  // 위 divider 드래그를 실제 마우스 없이 E2E 자가검증. kind = native-mousedown|native-mousemove|native-mouseup.
  register("webview.emitNative", {
    description: "Emit a native mouse-bridge event (native-mousedown/move/up) at viewport x,y — drives divider drag/resize over a native child (browser) without a real mouse, for E2E. Pair with ui.input.drag (DOM path); this is the native path. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.",
    params: {
      kind: { type: "string", description: "native-mousedown | native-mousemove | native-mouseup", required: true },
      x: { type: "number", description: "viewport x", required: true },
      y: { type: "number", description: "viewport y", required: true },
    },
    returns: "{ ok, kind }",
    message: (d) => tmsg("msg.webview.emitNative", { kind: String(d.kind) }),
    examples: ['webview.emitNative \'{"kind":"native-mousedown","x":400,"y":300}\''],
    handler: async (p) => {
      await invoke("webview_emit_native", { kind: p.kind, x: p.x, y: p.y });
      return { ok: true, kind: p.kind };
    },
  });
}
