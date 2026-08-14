// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/webviewLabels", () => ({
  currentWindowLabel: () => "",
  browserLabel: () => "",
  browserLabelIn: () => "",
}));

const { collectExposed } = await import("./catalogDom");
const { parseAddress } = await import("./address");

describe("exposed addresses without a window label", () => {
  it("emits addresses the parser accepts", () => {
    // The scan built `win/${label}/…` by template, so an empty label produced
    // `win//chrome/titlebar` — a string the parser refuses. ui.tree handed that
    // address out and ui.input.click then reported it as not exposed, which
    // named the address rather than the missing label (measured 2026-08-15).
    document.body.innerHTML = `<div data-node="titlebar"></div>`;

    for (const node of collectExposed()) {
      expect(parseAddress(node.address), `parsing ${node.address}`).not.toHaveProperty("error");
    }
  });

  it("omits the window segment rather than emitting an empty one", () => {
    document.body.innerHTML = `<div data-node="titlebar"></div>`;

    const addresses = collectExposed().map((node) => node.address);
    expect(addresses).toContain("chrome/titlebar");
    expect(addresses.some((address) => address.includes("win//"))).toBe(false);
  });
});
