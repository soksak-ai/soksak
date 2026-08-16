// @vitest-environment jsdom
// Node scan — data-node collection, absolute address, shadowRoot recursion, malformed/duplicate warning contract.
import { describe, expect, it } from "vitest";
import { scanNodes } from "./nodeScan";

function container(html: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "tab-viewer";
  div.innerHTML = html;
  return div;
}

const BASE = "center/view/soksak-plugin-x.main";

describe("scanNodes — collecting exposed nodes", () => {
  it("gives every data-node element an absolute address", () => {
    const c = container(`<button data-node="submit">send</button><div data-node="msg/3">row</div>`);
    const r = scanNodes(c, BASE);
    expect(r.map((n) => n.address)).toEqual([
      `${BASE}/node/submit`,
      `${BASE}/node/msg/3`,
    ]);
  });
  it("skips an element with no data-node (not exposed = absent)", () => {
    const c = container(`<button>not exposed</button><button data-node="ok">exposed</button>`);
    const r = scanNodes(c, BASE);
    expect(r).toHaveLength(1);
    expect(r[0].nodePath).toBe("ok");
  });
  it("keeps the el reference (resolve uses it directly)", () => {
    const c = container(`<button data-node="go">go</button>`);
    const r = scanNodes(c, BASE);
    expect(r[0].el.textContent).toBe("go");
  });
});

describe("scanNodes — shadowRoot recursion (Shadow DOM, as in erd)", () => {
  it("collects a data-node inside a shadow root", () => {
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

describe("scanNodes — malformed and duplicate warnings (no silence)", () => {
  it("warns and skips a malformed path", () => {
    const warns: string[] = [];
    const c = container(`<button data-node="Bad Upper">x</button><button data-node="ok">y</button>`);
    const r = scanNodes(c, BASE, (m) => warns.push(m));
    expect(r.map((n) => n.nodePath)).toEqual(["ok"]);
    expect(warns.some((w) => w.includes("data-node path"))).toBe(true);
  });
  it("warns and skips a duplicate path (the first one is kept)", () => {
    const warns: string[] = [];
    const c = container(`<button data-node="dup">1</button><button data-node="dup">2</button>`);
    const r = scanNodes(c, BASE, (m) => warns.push(m));
    expect(r).toHaveLength(1);
    expect(warns.some((w) => w.includes(`"dup"`))).toBe(true);
  });
});

describe("scanNodes — conformance (contributes.nodes declaration ≡ data-node wiring)", () => {
  it("warns on missing (declared, not wired) and orphan (wired, not declared) when declaredNodeIds is given", () => {
    const warns: string[] = [];
    const c = container(
      `<button data-node="send">s</button><span data-node="extra">e</span>`,
    );
    scanNodes(c, BASE, (m) => warns.push(m), ["send", "ghost"]);
    expect(
      warns.some(
        (w) => w.includes("declared-but-not-wired") && w.includes("ghost"),
      ),
    ).toBe(true);
    expect(
      warns.some(
        (w) => w.includes("wired-but-not-declared") && w.includes("extra"),
      ),
    ).toBe(true);
  });

  it("emits no conformance warning without declaredNodeIds (a plain scan is unchanged)", () => {
    const warns: string[] = [];
    const c = container(`<button data-node="anything">a</button>`);
    scanNodes(c, BASE, (m) => warns.push(m));
    expect(warns.some((w) => w.includes("not-declared"))).toBe(false);
  });

  it("matches a dynamic node (id/key) to its base id declaration (no warning)", () => {
    const warns: string[] = [];
    const c = container(
      `<div data-node="row/0">0</div><div data-node="row/1">1</div>`,
    );
    scanNodes(c, BASE, (m) => warns.push(m), ["row"]);
    expect(warns.some((w) => w.includes("not-wired") || w.includes("not-declared"))).toBe(false);
  });
});
