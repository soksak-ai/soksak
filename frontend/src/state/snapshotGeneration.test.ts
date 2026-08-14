// A human must be able to see **what is coming in** before an undo.
//
// The store itself keeps the undo slot (kv_past — unconditionally, for every write). This file once
// singled out "lossy writes" and kept a separate copy; writes that rule missed had no undo slot, and
// the same fact in two places returned a wrong value when only one side was updated. What is left
// here is counting size.
//
// RED basis (measured 2026-08-01): this size was counted against the **runtime shape**
// (`spaces`, `type:"leaf"`, `tabs`) and always answered 0. The stored shape is `contents`, `t:"l"`,
// `views`. The test was written against the runtime shape too, so it was GREEN and e2e caught it —
// **a mock that differs from the real shape hides a real defect.**
import { describe, it, expect } from "vitest";
import { snapshotSize } from "./snapshotGeneration";

// Built in the **stored shape** — the shape serialization actually leaves behind.
const snap = (projects: number, tabsPerSpace = 1, spacesPerProject = 1) => ({
  activeId: "p0",
  projects: Array.from({ length: projects }, (_, i) => ({
    id: `p${i}`,
    root: `/r${i}`,
    contents: Array.from({ length: spacesPerProject }, (_, s) => ({
      id: `s${i}-${s}`,
      layout: {
        t: "l",
        v: { views: Array.from({ length: tabsPerSpace }, (_, t) => ({ id: `t${t}` })) },
      },
    })),
  })),
});

describe("snapshot size is counted from the stored shape", () => {
  it("projects, spaces and tabs are counted", () => {
    expect(snapshotSize(snap(2, 3, 2))).toEqual({ projects: 2, spaces: 4, tabs: 12 });
  });

  it("an empty snapshot is 0", () => {
    expect(snapshotSize(snap(0))).toEqual({ projects: 0, spaces: 0, tabs: 0 });
  });

  it("a missing snapshot is 0 too — a throw at the counting site fails the whole undo query", () => {
    expect(snapshotSize(null)).toEqual({ projects: 0, spaces: 0, tabs: 0 });
  });

  it("tabs in a nested split are counted too — reading one level only drops the tabs of a split space", () => {
    const nested = {
      projects: [
        {
          contents: [
            {
              layout: {
                t: "s",
                children: [
                  { t: "l", v: { views: [{ id: "a" }, { id: "b" }] } },
                  { t: "s", children: [{ t: "l", v: { views: [{ id: "c" }] } }] },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(snapshotSize(nested)).toEqual({ projects: 1, spaces: 1, tabs: 3 });
  });

  it("the runtime shape is not counted — anything that is not the stored shape is 0", () => {
    // Without this check an implementation that confuses the two shapes passes GREEN (measured: it did).
    const runtime = { projects: [{ spaces: [{ layout: { type: "leaf", tabs: [1, 2] } }] }] };
    expect(snapshotSize(runtime)).toEqual({ projects: 1, spaces: 0, tabs: 0 });
  });
});
