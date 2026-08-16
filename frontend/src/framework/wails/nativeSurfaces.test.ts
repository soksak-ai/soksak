// @vitest-environment jsdom
// A surface declared after boot has to reach the compositor.
//
// Boot drops the previous session's native children before the restore render, so the old browser
// does not sit over an empty pre-restore screen. Measured 2026-08-16, that drop stopped the observer
// for the whole session: a browser pane declared its surface, the attributes were on the element —
// dom_query found all seven — and the compositor stayed at sequence 1 with count 0 forever, so the
// pane was an empty rectangle with nothing reporting why.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The window a commit names. A snapshot that named none let the host resolve whichever window it
// held, and a workspace window's browser was created inside the orchestrator (measured 2026-08-16).
vi.mock("../../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));

const commits: Array<{ window: string; sequence: number; surfaces: unknown[] }> = [];
vi.mock("../../../bindings/github.com/soksak/wails-service-native-compositor/service", () => ({
  Commit: vi.fn(async (snapshot: { window: string; sequence: number; surfaces: unknown[] }) => {
    commits.push({ window: snapshot.window, sequence: snapshot.sequence, surfaces: snapshot.surfaces });
    return { sequence: snapshot.sequence, accepted: true, surfaces: snapshot.surfaces };
  }),
}));
vi.mock("../../../bindings/github.com/soksak/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

import { clearNativeSurfaces, resetNativeSurfaces, startNativeSurfaces } from "./nativeSurfaces";

/** One pane's declaration, written the way the browser plugin writes it. */
function declare(id: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-native-surface", "browser");
  el.setAttribute("data-native-surface-id", id);
  el.setAttribute("data-native-generation", "1");
  el.setAttribute("data-native-source", JSON.stringify({ url: "https://example.com" }));
  el.setAttribute("data-native-visible", "true");
  el.setAttribute("data-native-alpha", "1");
  el.setAttribute("data-native-layer", "0");
  document.body.append(el);
  return el;
}

/** The observer collapses events into a microtask, so the assertion waits for it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the native surface observer", () => {
  beforeEach(() => {
    commits.length = 0;
    document.body.innerHTML = "";
  });

  it("carries a surface declared after start", async () => {
    startNativeSurfaces();
    await settle();
    declare("brw-a");
    await settle();
    expect(commits.at(-1)?.surfaces).toHaveLength(1);
  });

  it("carries a surface declared after the boot reset", async () => {
    // The reset is what boot does before the restore render. Everything the restore render declares
    // arrives after it, so an observer that stays stopped is a window with no native surfaces at all.
    startNativeSurfaces();
    await settle();
    await resetNativeSurfaces();
    await settle();
    declare("brw-a");
    await settle();
    expect(commits.at(-1)?.surfaces, "the declaration after the reset never reached the compositor").toHaveLength(1);
  });

  it("the reset itself commits an empty inventory", async () => {
    // Dropping the previous session's children is the point of the reset. Stopping the observer
    // without telling the compositor leaves them on screen — the reset would keep none of its
    // promise and report nothing.
    startNativeSurfaces();
    await settle();
    declare("brw-old");
    await settle();
    expect(commits.at(-1)?.surfaces).toHaveLength(1);

    document.body.innerHTML = "";
    await resetNativeSurfaces();
    await settle();
    expect(commits.at(-1)?.surfaces, "the reset left the old inventory in place").toHaveLength(0);
  });

  it("a clear destroys the children and stays stopped", async () => {
    // The window is about to go. A live observer would re-commit the declarations still in the
    // document and put the children straight back into the ~150ms gap the clear exists to empty.
    startNativeSurfaces();
    await settle();
    declare("brw-a");
    await settle();
    expect(commits.at(-1)?.surfaces).toHaveLength(1);

    await clearNativeSurfaces();
    await settle();
    expect(commits.at(-1)?.surfaces, "the clear did not empty the inventory").toHaveLength(0);

    declare("brw-b");
    await settle();
    expect(commits.at(-1)?.surfaces, "a stopped observer committed again").toHaveLength(0);
  });

  it("the sequence only rises across a reset", async () => {
    // The compositor refuses a stale sequence, so a reset that restarted the counter would have
    // every commit after it rejected, and the screen would freeze at the last accepted inventory.
    startNativeSurfaces();
    await settle();
    declare("brw-a");
    await settle();
    const before = commits.at(-1)!.sequence;
    await resetNativeSurfaces();
    await settle();
    declare("brw-b");
    await settle();
    expect(commits.at(-1)!.sequence).toBeGreaterThan(before);
  });
});
