// @vitest-environment jsdom
// 노드 스캔 — data-node 수집·절대주소·shadowRoot 재귀·불량/중복 경고 계약.
import { describe, expect, it } from "vitest";
import { scanNodes } from "./nodeScan";

function container(html: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "plugin-view-container";
  div.innerHTML = html;
  return div;
}

const BASE = "content/view/soksak-plugin-x.main";

describe("scanNodes — 노출 노드 수집", () => {
  it("data-node 요소를 절대 주소로", () => {
    const c = container(`<button data-node="submit">전송</button><div data-node="msg/3">행</div>`);
    const r = scanNodes(c, BASE);
    expect(r.map((n) => n.address)).toEqual([
      `${BASE}/node/submit`,
      `${BASE}/node/msg/3`,
    ]);
  });
  it("data-node 없는 요소는 수집 안 됨(미노출=부재)", () => {
    const c = container(`<button>노출 안 함</button><button data-node="ok">노출</button>`);
    const r = scanNodes(c, BASE);
    expect(r).toHaveLength(1);
    expect(r[0].nodePath).toBe("ok");
  });
  it("el 참조를 들고 있다(resolve 직접 사용)", () => {
    const c = container(`<button data-node="go">go</button>`);
    const r = scanNodes(c, BASE);
    expect(r[0].el.textContent).toBe("go");
  });
});

describe("scanNodes — shadowRoot 재귀(erd 같은 Shadow DOM)", () => {
  it("shadow 안의 data-node 도 수집", () => {
    const c = container(`<button data-node="light">light</button><div id="host"></div>`);
    const host = c.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("button");
    inner.dataset.node = "shadow-btn";
    shadow.appendChild(inner);

    const paths = scanNodes(c, BASE).map((n) => n.nodePath);
    expect(new Set(paths)).toEqual(new Set(["light", "shadow-btn"]));
  });
});

describe("scanNodes — 불량/중복 경고(침묵 금지)", () => {
  it("path 불량은 경고+무시", () => {
    const warns: string[] = [];
    const c = container(`<button data-node="Bad Upper">x</button><button data-node="ok">y</button>`);
    const r = scanNodes(c, BASE, (m) => warns.push(m));
    expect(r.map((n) => n.nodePath)).toEqual(["ok"]);
    expect(warns.some((w) => w.includes("불량"))).toBe(true);
  });
  it("중복 path 는 경고+무시(첫째만)", () => {
    const warns: string[] = [];
    const c = container(`<button data-node="dup">1</button><button data-node="dup">2</button>`);
    const r = scanNodes(c, BASE, (m) => warns.push(m));
    expect(r).toHaveLength(1);
    expect(warns.some((w) => w.includes("중복"))).toBe(true);
  });
});
