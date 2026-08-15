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
const snap = (workspaces: number, tabsPerSpace = 1, spacesPerWorkspace = 1) => ({
  activeId: "wsp-zzzzzz",
  workspaces: Array.from({ length: workspaces }, (_, i) => ({
    id: `p${i}`,
    root: `/r${i}`,
    contents: Array.from({ length: spacesPerWorkspace }, (_, s) => ({
      id: `s${i}-${s}`,
      layout: {
        t: "l",
        v: { views: Array.from({ length: tabsPerSpace }, (_, t) => ({ id: `t${t}` })) },
      },
    })),
  })),
});

describe("snapshot size is counted from the stored shape", () => {
  it("workspaces, spaces and tabs are counted", () => {
    expect(snapshotSize(snap(2, 3, 2))).toEqual({ workspaces: 2, spaces: 4, tabs: 12 });
  });

  it("an empty snapshot is 0", () => {
    expect(snapshotSize(snap(0))).toEqual({ workspaces: 0, spaces: 0, tabs: 0 });
  });

  it("a missing snapshot is 0 too — a throw at the counting site fails the whole undo query", () => {
    expect(snapshotSize(null)).toEqual({ workspaces: 0, spaces: 0, tabs: 0 });
  });

  it("tabs in a nested split are counted too — reading one level only drops the tabs of a split space", () => {
    const nested = {
      workspaces: [
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
    expect(snapshotSize(nested)).toEqual({ workspaces: 1, spaces: 1, tabs: 3 });
  });

  it("the runtime shape is not counted — anything that is not the stored shape is 0", () => {
    // Without this check an implementation that confuses the two shapes passes GREEN (measured: it did).
    const runtime = { workspaces: [{ spaces: [{ layout: { type: "leaf", tabs: [1, 2] } }] }] };
    expect(snapshotSize(runtime)).toEqual({ workspaces: 1, spaces: 0, tabs: 0 });
  });
});
