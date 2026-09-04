import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A component that draws a modal registers the overlay.
//
// `useOverlayActive` is the input gate: while it is held, a click over a native surface goes to the
// DOM instead of through it. The plugin manager was moved out of the right sidebar on 2026-08-17 and
// did not take the hook with it — inside that sidebar it had stood above the surfaces because the
// panel declares `will-change: transform`, and mounted by App it did not. A browser drew over the
// card, measured on the running build.
//
// So the rule is not about that one modal: a file that renders `dmodal-overlay` holds the hook.
const COMPONENTS = join(process.cwd(), "src", "components");

const files = readdirSync(COMPONENTS)
  .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
  .map((name) => ({ name, body: readFileSync(join(COMPONENTS, name), "utf8") }));

const drawsAModal = files.filter((file) => file.body.includes('className="dmodal-overlay"'));

// Whether the registration is released is not readable from the shape of the source: a modal its
// parent renders conditionally may register for its whole life, and one App mounts always may not.
// The installed-product UI suite reads the rejection and surface-coverage verdict with no modal
// open. Source inspection cannot prove release timing, so this test owns only registration.
describe("a component that draws a modal", () => {
  it("there is at least one, so this rule is measured", () => {
    expect(drawsAModal.map((f) => f.name).length).toBeGreaterThan(0);
  });

  it.each(drawsAModal.map((f) => f.name))("%s registers the overlay input gate", (name) => {
    const body = files.find((f) => f.name === name)!.body;
    expect(
      body.includes("useOverlayActive"),
      `${name} draws a modal and does not hold useOverlayActive; a click over a native surface goes through the card`,
    ).toBe(true);
  });

  it("the window presentation gate places every DOM overlay above native decorations", () => {
    // The native plane is above the document, so what an overlay covers must be withheld from it.
    // The gate reads the wiring rather than a verbatim line: it is the overlay state that has to
    // reach the plane, and how it is spelled is the file's own business.
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    const call = /setNativeDecorationOverlays\(\s*([A-Za-z]+)\s*\)/.exec(app);
    expect(call, "App does not hand the overlays to the native decoration plane").not.toBeNull();
    const source = new RegExp(
      `const ${call![1]} = useUi\\(\\(s\\) => s\\.nativeOverlayAreas\\)`,
    );
    expect(app, `${call![1]} is not the overlay areas the ui state holds`).toMatch(source);
  });

});

describe("settings modal automation boundary", () => {
  const settings = files.find((file) => file.name === "SettingsModal.tsx")!.body;

  it("exposes its overlay, card, drag handle, and close action", () => {
    for (const node of ["settings/modal", "settings/card", "settings/header", "settings/close"]) {
      expect(settings, `SettingsModal.tsx does not expose ${node}`).toContain(`data-node="${node}"`);
    }
  });
});
