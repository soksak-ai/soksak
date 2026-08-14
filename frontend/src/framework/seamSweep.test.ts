// Does the sweep actually bite — the oracle for the gate.
//
// Without this file the gate reports "0 hits" and that 0 cannot be separated into clean source versus
// a sweep that matched nothing.
import { describe, expect, it } from "vitest";
import { leaksIn, stripComments, VENDOR_DECL } from "./seamSweep";

describe("declarative vendor leak sweep", () => {
  it("every kind is caught", () => {
    const cases: [string, string][] = [
      ["a.tsx", '<div data-tauri-drag-region>'],
      ["a.css", ".x { -webkit-app-region: drag; }"],
      ["a.ts", "window.__TAURI_INTERNALS__.transformCallback()"],
      ["a.ts", 'const u = "tauri://localhost/x"'],
      ["a.ts", 'const u = "asset://x"'],
      ["a.ts", "const u = convertFileSrc(p)"],
      ["a.ts", "window.electron.ipcRenderer"],
    ];
    for (const [f, src] of cases) {
      expect(leaksIn(f, src), src).toHaveLength(1);
    }
    // Declared kind count equals caught kind count — no entry stays in the table uncaught.
    expect(cases).toHaveLength(VENDOR_DECL.length);
  });

  it("the hit includes the reason — a bare name forces another investigation of why it is banned", () => {
    const [hit] = leaksIn("a.tsx", "<div data-tauri-drag-region>");
    expect(hit).toContain("data-tauri-drag-region");
    expect(hit).toContain("data-tauri-drag-region");
  });

  it("comments are not counted — a hit there would force deleting the explanation", () => {
    expect(leaksIn("a.ts", "// asset:// is not used")).toEqual([]);
    expect(leaksIn("a.ts", "/* why data-tauri-drag-region is not used */")).toEqual([]);
    // But a hit in code is still caught — comment stripping must not eat code.
    expect(leaksIn("a.ts", 'x = "asset://y"; // note')).toHaveLength(1);
  });

  it("the // of a URL scheme is not read as a line comment — that would hide the leak forever", () => {
    expect(stripComments('const u = "tauri://x"')).toContain("tauri://x");
    expect(leaksIn("a.ts", 'const u = "tauri://x"')).toHaveLength(1);
  });

  it("clean source reports 0 hits", () => {
    expect(leaksIn("a.tsx", '<div className="titlebar" {...dragRegion}>')).toEqual([]);
  });
});
