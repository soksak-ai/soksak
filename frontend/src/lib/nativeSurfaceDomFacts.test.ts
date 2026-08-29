// @vitest-environment jsdom
// A native surface may name a pane inside one view. Ownership comes from the public tab anchor,
// never from decomposing the surface id as though its last field were the view id.
import { describe, expect, it } from "vitest";

import { nativeSurfaceDomFacts } from "./contentViews";

describe("native surface DOM ownership facts", () => {
  it("reads the owner view from the explicit tab anchor", () => {
    document.body.innerHTML = `
      <section data-tab-id="tab-terminal">
        <div
          data-native-surface="terminal"
          data-native-surface-id="terminal.win-test.tab-terminal-1"
          data-native-generation="7"
          data-native-visible="true"
          data-native-alpha="0.5"
          data-native-layer="2"
        ></div>
      </section>`;

    expect(nativeSurfaceDomFacts()).toEqual([
      {
        id: "terminal.win-test.tab-terminal-1",
        kind: "terminal",
        ownerViewId: "tab-terminal",
        generation: 7,
        declaredVisible: true,
        declaredAlpha: 0.5,
        layer: 2,
        rect: { x: 0, y: 0, w: 0, h: 0 },
      },
    ]);
  });
});
