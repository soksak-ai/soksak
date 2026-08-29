// @vitest-environment jsdom
// **One call emits a whole gesture.**
//
// The pointer injected into a native surface (child webview) had only two events until now, down
// and up. On such a surface there was no way to emit a double click, a drag, or a right button —
// the human hand can do it but the command surface had no place for it, and with no place there is
// no verification.
//
// The caller must not stitch the steps together. That hands the interval to the caller, and a CLI
// round trip exceeds the double-click interval (0.5s by default) — measured 2026-08-08: sending
// two presses as two calls made the engine read two separate single clicks. The steps of a gesture
// go out **consecutively inside one call**.
//
// A drag is not `move`. Moving with a button held makes the OS emit mouseDragged. Sent as
// mouseMoved, the mousemove the page receives has `buttons` 0, so code that branches on a held
// button does nothing. That is why the contract declares `drag` separately.
//
// A projection node takes the same path. That spot is a transparent div mirroring a fact of
// another realm, and the real node is in the child document. Until now only click was handed over
// as an `el.click()` synthesis, and that click has neither down nor up, so it cannot build a
// double click or a drag. Inject a real pointer at the coordinate inside that realm — one path,
// the same one the human hand takes. That coordinate is **the value the projection supplies**, not
// a value subtracted from host geometry: where the host placed the projection and where the node
// is inside its own realm are different facts, and the moment the realm scrolls or the container
// has padding, the subtraction silently names a different point.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = vi.hoisted(() => ({
  sendInput: vi.fn(async (_label: string, _input: unknown) => {}),
  wheel: vi.fn(async (_label: string, _input: unknown) => {}),
  evalJs: vi.fn(async () => "ok"),
  typeText: vi.fn(async () => {}),
}));

vi.mock("../lib/contentViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/contentViews")>()),
  hasContentViewHost: () => true,
  contentViewHost: () => host,
}));
vi.mock("../lib/webviewLabels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/webviewLabels")>()),
  currentWindowLabel: () => "main",
  browserLabel: (viewId: string) => `browser.main.${viewId}`,
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => ({})),
  currentWindow: () => ({ innerPosition: async () => ({ x: 0, y: 0 }), scaleFactor: async () => 1 }),
}));

import { registerDomCatalog, resolveExposed } from "./catalogDom";
import { registerSurfaceInputProvider } from "../lib/surfaceInputProviders";
import { catalogJson, execute, unregister } from "./registry";

const VIEW = "center/view/test.v";
const at = (el: Element, x: number, y: number, w: number, h: number) => {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
};

/** Mounts one content surface at that address. */
function mountSurface(): string {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="${VIEW}">` +
    `<div data-node="cv" data-content-view="browser.main.tab-4h7kq2"></div></div>`;
  at(document.querySelector("[data-node=cv]")!, 0, 0, 800, 600);
  return `win/main/${VIEW}/node/cv`;
}

/** Mounts one projection node — it **declares where inside that realm it is** itself.
 *
 * The position in the host document (110,60) and the position inside that realm (10,10) are
 * different facts. They are deliberately different here — deriving realm coordinates by
 * subtraction diverges immediately in this fixture. */
function mountProjection(node = "urlbar"): string {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
    `<div data-realm="rlm-main-2" data-realm-node="${node}" data-realm-x="10" data-realm-y="10"` +
    ` data-node="plugin-view/rlm-main-2/${node}"></div></div></div>`;
  at(document.querySelector("#box")!, 100, 50, 400, 40);
  at(document.querySelector("[data-realm]")!, 110, 60, 80, 20);
  return `win/main/${VIEW}/node/plugin-view/rlm-main-2/${node}`;
}

const sent = (label: string) =>
  host.sendInput.mock.calls.filter(([l]) => l === label).map(([, i]) => i as Record<string, unknown>);

beforeEach(() => {
  host.sendInput.mockClear();
  host.wheel.mockClear();
  host.evalJs.mockClear();
  registerDomCatalog();
});
afterEach(() => {
  // Everything on the table, not everything whose name starts a certain way. A prefix is a
  // hand-written list wearing a pattern — measured 2026-08-18, `rail.settled` joined catalogDom and
  // the next beforeEach failed with "duplicate registration". Only catalogDom registers into this
  // suite's registry, so clearing it is clearing what it put there.
  for (const { name } of catalogJson()) unregister(name);
  document.body.innerHTML = "";
});

describe("contract — a drag is a different event from a move", () => {
  it("the pointer event kinds include drag", () => {
    const contract = readFileSync(resolve(__dirname, "../lib/contentViews.ts"), "utf8");
    expect(contract).toMatch(/kind:\s*"down"\s*\|\s*"up"\s*\|\s*"move"\s*\|\s*"drag"/);
    expect(contract).toMatch(/button:\s*"left"\s*\|\s*"middle"\s*\|\s*"right"/);
    expect(contract).toMatch(/modifiers:\s*\{\s*shift:\s*boolean;\s*alt:\s*boolean;\s*control:\s*boolean;\s*meta:\s*boolean/);
  });
});

describe("gestures on a surface", () => {
  it("routes wheel delta and position through the addressed surface input realm", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.wheel", {
      from: addr, x: 10, y: 20, deltaX: 0, deltaY: 120, deltaMode: "pixel",
      shift: false, alt: false, control: false, meta: false,
    }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(host.wheel).toHaveBeenCalledWith("browser.main.tab-4h7kq2", {
      x: 10, y: 20, deltaX: 0, deltaY: 120, deltaMode: "pixel",
      modifiers: { shift: false, alt: false, control: false, meta: false },
    });
  });

  it("routes a native surface declaration to its owner instead of synthesizing host DOM input", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}">` +
      `<div data-node="terminal-screen/1" data-native-surface="terminal"` +
      ` data-native-surface-id="terminal.win-test.tab-native-1"></div></div>`;
    at(document.querySelector('[data-node="terminal-screen/1"]')!, 0, 0, 330, 468);
    const owner = {
      owns: (label: string) => label === "terminal.win-test.tab-native-1",
      sendInput: vi.fn(async (_label: string, _input: unknown) => {}),
      sendWheel: vi.fn(async (_label: string, _input: unknown) => {}),
      inputState: vi.fn(async () => ({})),
    };
    const dispose = registerSurfaceInputProvider("soksak-plugin-terminal-vision", owner);
    const address = `win/main/${VIEW}/node/terminal-screen/1`;
    const resolved = resolveExposed(address);
    expect("el" in resolved && resolved.el.getAttribute("data-native-surface-id"))
      .toBe("terminal.win-test.tab-native-1");
    const out = await execute("ui.input.drag", {
      from: address, x: 5, y: 20, dx: 80, dy: 0, steps: 2,
    }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect((out.data as { surface?: string } | undefined)?.surface)
      .toBe("terminal.win-test.tab-native-1");
    expect(owner.sendInput.mock.calls.map(([, input]) => (input as { kind: string }).kind))
      .toEqual(["down", "drag", "drag", "up"]);
    const wheel = await execute("ui.input.wheel", {
      from: address, x: 15, y: 25, deltaX: 0, deltaY: -2, deltaMode: "line",
      shift: true, alt: false, control: false, meta: false,
    }, {});
    expect(wheel.ok, JSON.stringify(wheel)).toBe(true);
    expect(owner.sendWheel).toHaveBeenCalledWith("terminal.win-test.tab-native-1", {
      x: 15, y: 25, deltaX: 0, deltaY: -2, deltaMode: "line",
      modifiers: { shift: true, alt: false, control: false, meta: false },
    });
    dispose();
  });

  it("routes a host layout tab to the exact surface label declared by its plugin owner", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}">` +
      `<div data-node="layout/tab/tab-terminal"></div></div>`;
    at(document.querySelector('[data-node="layout/tab/tab-terminal"]')!, 0, 0, 800, 600);
    const owner = {
      owns: (label: string) => label === "terminal.win-test.tab-terminal-1",
      labelOfView: (viewId: string) => viewId === "tab-terminal" ? "terminal.win-test.tab-terminal-1" : null,
      sendInput: vi.fn(async (_label: string, _input: unknown) => {}),
      sendWheel: vi.fn(async (_label: string, _input: unknown) => {}),
      inputState: vi.fn(async () => ({})),
    };
    const dispose = registerSurfaceInputProvider("soksak-plugin-terminal-vision", owner);
    const out = await execute("ui.input.click", {
      address: `win/main/${VIEW}/node/layout/tab/tab-terminal`, x: 25, y: 20,
    }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(owner.sendInput.mock.calls.map(([, input]) => (input as { kind: string }).kind)).toEqual(["down", "up"]);
    dispose();
  });

  it("a double click sends four events in one call and the second press has clickCount 2", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.dblclick", { address: addr, x: 40, y: 12 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("browser.main.tab-4h7kq2");
    expect(seq.map((s) => `${s.kind}${s.clickCount}`)).toEqual(["down1", "up1", "down2", "up2"]);
    expect(seq.every((s) => s.x === 40 && s.y === 12)).toBe(true);
  });

  it("a right-button click is sent with the right button", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.click", { address: addr, x: 5, y: 6, button: "right" }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("browser.main.tab-4h7kq2").map((s) => `${s.kind}:${s.button}`)).toEqual(["down:right", "up:right"]);
  });

  // No leading move — the press creates the hover at that spot, and on an engine that cannot take
  // a move, one leading step kills the whole drag (measured 2026-08-08).
  it("a drag presses, moves with drag steps, and releases at the end", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.drag", { from: addr, x: 10, y: 10, dx: 60, dy: 20, steps: 3 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("browser.main.tab-4h7kq2");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 10, y: 10 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 70, y: 30 });
  });

  // On a framework that can inject, the pointer enters and then moves. An engine that cannot
  // inject refuses that fact with a name (SURFACE_INPUT_UNAVAILABLE) — what is verified here is
  // **what gets sent**, not whether that engine receives it.
  it("a pointer move sends a real move into the surface", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.pointer", { address: addr, x: 33, y: 44 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // Enter, then move — the order a human pointer follows, and the engine opens hover on that pair.
    expect(sent("browser.main.tab-4h7kq2")).toEqual([
      { x: 33, y: 44, kind: "enter", button: "left", clickCount: 1 },
      { x: 33, y: 44, kind: "move", button: "left", clickCount: 1 },
    ]);
  });
});

describe("gestures on a projected node — a real pointer into that realm", () => {
  it("a click goes to that spot on the realm surface", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // Declared realm position (10,10) + the center of its size (80x20) → (50,20). The host
    // position (110,60) does not mix into the answer.
    expect(sent("rlm-main-2").map((s) => `${s.kind}@${s.x},${s.y}`)).toEqual(["down@50,20", "up@50,20"]);
  });

  it("a double click is not refused either and holds in that realm", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.dblclick", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("rlm-main-2").map((s) => s.clickCount)).toEqual([1, 1, 2, 2]);
  });

  it("drags between two nodes inside one realm", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-realm="rlm-main-2" data-realm-node="a" data-realm-x="10" data-realm-y="10"` +
      ` data-node="plugin-view/rlm-main-2/a"></div>` +
      `<div data-realm="rlm-main-2" data-realm-node="b" data-realm-x="110" data-realm-y="10"` +
      ` data-node="plugin-view/rlm-main-2/b"></div></div></div>`;
    at(document.querySelector("#box")!, 100, 50, 400, 40);
    at(document.querySelector("[data-node$='/a']")!, 110, 60, 20, 20);
    at(document.querySelector("[data-node$='/b']")!, 210, 60, 20, 20);
    const out = await execute("ui.input.drag", {
      from: `win/main/${VIEW}/node/plugin-view/rlm-main-2/a`,
      to: `win/main/${VIEW}/node/plugin-view/rlm-main-2/b`,
      steps: 2,
    }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("rlm-main-2");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 20, y: 20 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 120, y: 20 });
  });

  it("a pointer move goes into that realm too", async () => {
    const addr = mountProjection();
    const out = await execute("ui.input.pointer", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(sent("rlm-main-2").map((s) => s.kind)).toEqual(["enter", "move"]);
  });
});

// A projection mirrors two things. One is **a node of another realm** (address bar, buttons); the
// other is the **place** that realm gave to content (the surface the page is laid on). The two
// share a name shape — `…/plugin-view/<middle>/…` — but the middle segment means different things:
// the first is a renderer realm, the second is the label of a content surface.
//
// Measured 2026-08-08: splitting them by name shape read a content surface as a realm, and the
// coordinate origin was taken as the realm container. And the old path that found a surface from a
// tab node looked at `data-content-view`, an attribute only one framework has, so on the other
// framework the click leaked silently into the host DOM — the response was `clicked:true` and
// nothing arrived at the page.
//
// No guessing from names. The projection **declares** what it is: `data-surface` means a place,
// `data-realm` means a node inside that realm, and then the position inside the realm
// (`data-realm-x/y`) and the node address inside the realm (`data-realm-node`) go with it. With
// any one of them missing the operation does not hold, so the core refuses on the spot with a
// name — it does not push down into the host DOM.
describe("a projection declares what it is", () => {
  // Check on the **reading side** of the declaration. Grepping the producing side's source as a
  // string guards that one file only, and the day the next framework arrives nobody inherits that
  // check. The core requires a fact, not a file — with no declaration the operation does not hold.
  it("declaring only the realm and not the place inside it is refused with a name", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-realm="rlm-main-2" data-node="plugin-view/rlm-main-2/urlbar"></div></div></div>`;
    at(document.querySelector("#box")!, 100, 50, 400, 40);
    at(document.querySelector("[data-realm]")!, 110, 60, 80, 20);
    const addr = `win/main/${VIEW}/node/plugin-view/rlm-main-2/urlbar`;
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PROJECTION_UNDECLARED");
    // **It did not push down into the host DOM** — landing there would have reached nothing and
    // still returned success.
    expect(host.sendInput.mock.calls).toEqual([]);
  });

  it("fill is refused too when the node inside the realm is undeclared", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-realm="rlm-main-2" data-realm-x="10" data-realm-y="10"` +
      ` data-node="plugin-view/rlm-main-2/urlbar"></div></div></div>`;
    at(document.querySelector("#box")!, 100, 50, 400, 40);
    at(document.querySelector("[data-realm]")!, 110, 60, 80, 20);
    const addr = `win/main/${VIEW}/node/plugin-view/rlm-main-2/urlbar`;
    const out = await execute("ui.input.fill", { address: addr, value: "x" }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PROJECTION_UNDECLARED");
  });

  it("addressing a slot projection goes to that content surface, in surface-relative coordinates", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="chromium-tab-1" data-node="plugin-view/chromium-tab-1/surface"></div>` +
      `</div></div>`;
    at(document.querySelector("#box")!, 100, 50, 900, 700);
    at(document.querySelector("[data-surface]")!, 220, 150, 800, 600);
    const addr = `win/main/${VIEW}/node/plugin-view/chromium-tab-1/surface`;
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    // The top left inside the surface is (0,0) — where that surface was placed on screen is not
    // the page's concern.
    expect(sent("chromium-tab-1").map((s) => `${s.kind}@${s.x},${s.y}`)).toEqual(["down@0,0", "up@0,0"]);
  });

  it("a drag on a slot projection also goes in surface coordinates", async () => {
    document.body.innerHTML =
      `<div class="tab-viewer" data-view-addr="${VIEW}"><div id="box">` +
      `<div data-surface="offscreen-tab-9" data-node="plugin-view/offscreen-tab-9/surface"></div>` +
      `</div></div>`;
    at(document.querySelector("#box")!, 0, 0, 900, 700);
    at(document.querySelector("[data-surface]")!, 220, 150, 800, 600);
    const addr = `win/main/${VIEW}/node/plugin-view/offscreen-tab-9/surface`;
    const out = await execute("ui.input.drag", { from: addr, x: 10, y: 20, dx: 100, dy: 0, steps: 2 }, {});
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const seq = sent("offscreen-tab-9");
    expect(seq.map((s) => s.kind)).toEqual(["down", "drag", "drag", "up"]);
    expect(seq[0]).toMatchObject({ x: 10, y: 20 });
    expect(seq[seq.length - 1]).toMatchObject({ x: 110, y: 20 });
  });
});

// A surface existing does not mean **this framework holds that surface.** A surface drawn by a
// sidecar engine is owned by that plugin, and the core's input channel does not reach it.
//
// Measured 2026-08-08: sending a gesture to the chromium and offscreen surfaces produced the
// generic "execution failed unexpectedly" message — with no statement of what failed and why, the
// caller suspects its own address. A refusal must state the code and which surface.
describe("another owner's surface is refused with a name", () => {
  it("answers with the code and the surface name when the input path has no route to that surface", async () => {
    const addr = mountSurface();
    host.sendInput.mockRejectedValueOnce(new Error("no webview: b-main-t1"));
    const out = await execute("ui.input.click", { address: addr }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SURFACE_INPUT_UNAVAILABLE");
    expect(String(out.message)).toContain("browser.main.tab-4h7kq2");
    expect(String(out.message)).toContain("no webview");
  });

  it("a drag is refused with the same name — it does not leak as an exception", async () => {
    const addr = mountSurface();
    host.sendInput.mockRejectedValueOnce(new Error("no webview: b-main-t1"));
    const out = await execute("ui.input.drag", { from: addr, dx: 40 }, {});
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SURFACE_INPUT_UNAVAILABLE");
  });
});

// When a surface has its own owner, the gesture goes **to that owner** — a surface the core's
// channel does not reach still takes gestures.
//
// Measured 2026-08-08: of three browser kinds only the one the framework held took gestures; the
// two drawn by engine sidecars were refused with "no webview". Fixing that by teaching the core
// about that engine is coupling; letting the owner answer for itself leaves the core delivering
// without knowing any engine.
describe("delivery goes to the surface owner", () => {
  it("with an owner present the owner receives it, not the framework", async () => {
    const addr = mountSurface();
    const owner = {
      owns: (label: string) => label === "browser.main.tab-4h7kq2",
      sendInput: vi.fn(async () => {}),
      sendWheel: vi.fn(async () => {}),
      inputState: vi.fn(async () => ({ attached: true })),
    };
    const dispose = registerSurfaceInputProvider("plugin-x", owner);
    try {
      const out = await execute("ui.input.click", { address: addr, x: 3, y: 4 }, {});
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(owner.sendInput).toHaveBeenCalledTimes(2);
      expect(host.sendInput).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("with no owner the framework receives it", async () => {
    const addr = mountSurface();
    const out = await execute("ui.input.click", { address: addr, x: 3, y: 4 }, {});
    expect(out.ok).toBe(true);
    expect(host.sendInput).toHaveBeenCalled();
  });

  it("a drag goes to the owner too — fixing one path alone leaves the other gestures silently behind", async () => {
    const addr = mountSurface();
    const owner = {
      owns: () => true,
      sendInput: vi.fn(async () => {}),
      sendWheel: vi.fn(async () => {}),
      inputState: vi.fn(async () => ({ attached: true })),
    };
    const dispose = registerSurfaceInputProvider("plugin-x", owner);
    try {
      await execute("ui.input.dblclick", { address: addr }, {});
      await execute("ui.input.drag", { from: addr, dx: 40, steps: 2 }, {});
      expect(owner.sendInput.mock.calls.length).toBeGreaterThanOrEqual(8);
      expect(host.sendInput).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
