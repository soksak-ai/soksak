// The fingerprint answers two numbers, because it judges two things.
//
// `digest` is the shape: rectangles, the active pane, the rail, ordered by root.
// It holds no id on purpose — a root is the workspace's identity and a rectangle
// is what a person sees.
//
// That is right for what it judges and blind to what it does not. Measured
// 2026-08-16: a change that renamed every identifier on restore matched the
// digest exactly, because the digest never held one, and it broke the terminal
// reattach key (`windowLabel + "|" + paneId`). The one number the restore is
// judged by could not see the defect, and the gate built on it passed.
//
// Every identifier survives a restart (NAMING N2a, RESTORE R3), so `ids` is a
// second digest over exactly those. Beside the first, never mixed into it: one
// answers "is the layout the same", the other "are these the same things", and a
// caller told only that "something moved" has to find out which.
import { describe, expect, it } from "vitest";

import { fingerprintOf } from "./stateFingerprint";

const tree = (paneId: string, spaceId: string, workspaceId: string) => ({
  workspaces: [
    {
      id: workspaceId,
      root: "/workspaces/one",
      railPosition: { mode: "flow", effectiveStation: 0, cleanLines: [] },
      spaces: [
        {
          id: spaceId,
          activePaneId: paneId,
          panes: [{ id: paneId, rect: { left: 0, top: 0, width: 100, height: 100 } }],
        },
      ],
    },
  ],
});

describe("the two numbers", () => {
  it("answers an ids digest beside the shape digest", () => {
    const print = fingerprintOf(tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"));
    expect(print.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(print.ids).toMatch(/^[0-9a-f]{8}$/);
    // Two questions, two answers. One number for both would make a renaming and
    // a moved pane the same event.
    expect(print.ids).not.toBe(print.digest);
  });

  it("moves the ids digest when a name changes, and leaves the shape alone", () => {
    const before = fingerprintOf(tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"));
    const renamed = fingerprintOf(tree("pan-bbbbbb", "spc-aaaaaa", "wsp-aaaaaa"));

    expect(renamed.digest, "the layout did not move").toBe(before.digest);
    expect(renamed.ids, "a pane was renamed and the ids digest did not move").not.toBe(before.ids);
  });

  it("moves the shape digest when the layout changes, and leaves the ids alone", () => {
    const before = fingerprintOf(tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"));
    const moved = fingerprintOf({
      ...tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"),
      workspaces: [
        {
          ...tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa").workspaces[0]!,
          spaces: [
            {
              id: "spc-aaaaaa",
              activePaneId: "pan-aaaaaa",
              panes: [{ id: "pan-aaaaaa", rect: { left: 0, top: 0, width: 200, height: 100 } }],
            },
          ],
        },
      ],
    });

    expect(moved.digest).not.toBe(before.digest);
    expect(moved.ids, "nothing was renamed and the ids digest moved").toBe(before.ids);
  });

  it("reads the same recording twice the same way", () => {
    const one = fingerprintOf(tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"));
    const two = fingerprintOf(tree("pan-aaaaaa", "spc-aaaaaa", "wsp-aaaaaa"));
    expect(two.ids).toBe(one.ids);
  });
});
