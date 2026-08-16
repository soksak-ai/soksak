// A composite identifier decomposes. It is never searched.
//
// docs/tech/NAMING.md N3: a surface label is `<kind>.<window>.<view>` — three
// fields, one delimiter, that order — and the delimiter is one no field admits,
// so a reader splits and indexes rather than scanning for a field it hopes to
// recognise.
//
// Measured 2026-08-16 in the running application:
// `browser-win-8ed56cd7d9305935-tab-2trqyu`. Three fields joined with `-`, and
// every field holds `-`: a window name is `win-<body>`, a view id is
// `tab-<body>`, a kind may hold one. So the value could not be parsed, and
// viewIdFromSurfaceLabel found the view with `indexOf("-" + window + "-")`
// while orphanSurfaceLabels matched a window with `includes("-" + name + "-")`.
// A kind ending in a window name yields a view id taken from the wrong field,
// and AGENTS 3-4 names a structure that has to be searched as a failure.
//
// This is the gate NAMING.md N3 states must exist, refusing the three things it
// names there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  orphanSurfaceLabels,
  surfaceLabelIn,
  surfaceLabelPrefixIn,
  viewIdFromSurfaceLabel,
} from "./surfaceLabels";

const WINDOW = "win-3ztbjd";
const VIEW = "tab-2trqyu";

describe("the grammar", () => {
  it("joins three fields with a delimiter no field admits", () => {
    expect(surfaceLabelIn("browser", WINDOW, VIEW)).toBe("browser.win-3ztbjd.tab-2trqyu");
  });

  it("puts the widest scope first, so one window's surfaces of one kind share a prefix", () => {
    const prefix = surfaceLabelPrefixIn("browser", WINDOW);
    expect(surfaceLabelIn("browser", WINDOW, VIEW).startsWith(prefix)).toBe(true);
    // A different window does not share it, which is what the prefix is for.
    expect(surfaceLabelIn("browser", "win-9m3xb5", VIEW).startsWith(prefix)).toBe(false);
  });

  it("reads a kind this core does not name", () => {
    // The kind is the plugin's word. A reader that matched on a known kind would
    // answer null for every surface it had not been taught about.
    const label = surfaceLabelIn("video", WINDOW, VIEW);
    expect(viewIdFromSurfaceLabel(label, WINDOW)).toBe(VIEW);
  });
});

describe("a field outside its alphabet is refused, not assembled", () => {
  it("refuses a delimiter inside a field", () => {
    // Assembled anyway, the value has four fields and decomposes to nothing.
    expect(() => surfaceLabelIn("brow.ser", WINDOW, VIEW)).toThrow(/kind/);
    expect(() => surfaceLabelIn("browser", "win.3ztbjd", VIEW)).toThrow(/window/);
    expect(() => surfaceLabelIn("browser", WINDOW, "tab.2trqyu")).toThrow(/view/);
  });

  it("refuses a kind outside lowercase letters, digits and a dash", () => {
    for (const kind of ["Browser", "browser surface", "browser/native", ""]) {
      expect(() => surfaceLabelIn(kind, WINDOW, VIEW)).toThrow(/kind/);
    }
  });
});

describe("a reader answers nothing rather than picking a field", () => {
  it("refuses a value that is not exactly three fields", () => {
    expect(viewIdFromSurfaceLabel("browser.win-3ztbjd", WINDOW)).toBeNull();
    expect(viewIdFromSurfaceLabel("browser.win-3ztbjd.tab-2trqyu.extra", WINDOW)).toBeNull();
    expect(viewIdFromSurfaceLabel("browser-win-3ztbjd-tab-2trqyu", WINDOW)).toBeNull();
    expect(viewIdFromSurfaceLabel("", WINDOW)).toBeNull();
  });

  it("answers null for another window's label rather than a view id from it", () => {
    expect(viewIdFromSurfaceLabel(surfaceLabelIn("browser", "win-9m3xb5", VIEW), WINDOW)).toBeNull();
  });

  it("names an orphan by its window field alone", () => {
    const live = surfaceLabelIn("browser", WINDOW, VIEW);
    const gone = surfaceLabelIn("browser", "win-9m3xb5", VIEW);
    expect(orphanSurfaceLabels([live, gone], [WINDOW])).toEqual([gone]);
    // A window name occurring inside another field must not save a label. The
    // kind here ends in the live window's name, which is exactly what the old
    // `includes("-" + name + "-")` matched on.
    const impostor = surfaceLabelIn(`kind-${WINDOW}`, "win-9m3xb5", VIEW);
    expect(orphanSurfaceLabels([impostor], [WINDOW])).toEqual([impostor]);
  });
});

// A rule against scanning that no scan enforces is prose (NAMING N3).
it("locates a field by splitting, never by scanning", () => {
  const source = readFileSync(join(__dirname, "surfaceLabels.ts"), "utf8");
  for (const scan of ["indexOf(", "includes(", ".search(", ".match("]) {
    expect(source, `surfaceLabels.ts uses ${scan} — a label is split, not searched`)
      .not.toContain(scan);
  }
});
