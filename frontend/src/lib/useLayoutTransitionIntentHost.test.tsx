// @vitest-environment jsdom
// A state mutation starts native preparation before React publishes the target DOM. Changing the
// render callback must update the next preparation without unregistering the owner of the active one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLayoutTransitionIntentForTest,
  claimLayoutTransitionIntent,
  finishLayoutTransitionIntent,
  publishLayoutTransitionIntent,
  type LayoutTransitionIntent,
} from "./layoutTransitionIntent";
import type { PreparedLayoutTransition } from "./layoutTransitionHost";
import { useLayoutTransitionIntentHost } from "./useLayoutTransitionIntentHost";
import { singlePane } from "../state/panePlane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const arrangement = (railPresent: boolean): LayoutTransitionIntent["from"] => ({
  station: railPresent ? 500 : 0,
  cleanLines: [0, 500, 1000],
  standingLines: [0, 1, 2],
  lineSet: "1x1:pane@0-1,0-1",
  display: singlePane("pane"),
  rail: railPresent ? { left: 500, top: 0, width: 100, height: 1000 } : null,
  dividers: [],
  swapped: false,
  cells: [{ id: "pane", rect: { left: 0, top: 0, width: 1000, height: 1000 } }],
  focusId: "pane",
  betweenIds: [],
  maximizedId: null,
  railPresent,
});

const prepared = (id: string): PreparedLayoutTransition => ({
  transactionId: id,
  mode: "glide",
  requiresSharedStart: false,
  stagedTargets: [],
  start: vi.fn(async () => null),
  commit: vi.fn(async () => {}),
  cancel: vi.fn(),
});

function Probe({
  prepare,
}: {
  prepare: (
    intent: LayoutTransitionIntent,
    signal: AbortSignal,
  ) => Promise<PreparedLayoutTransition>;
}) {
  useLayoutTransitionIntentHost("workspace", prepare);
  return null;
}

describe("layout transition intent host lifetime", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    __resetLayoutTransitionIntentForTest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    __resetLayoutTransitionIntentForTest();
  });

  it("keeps an active preparation while adopting the next prepare callback", async () => {
    let resolveFirst!: (value: PreparedLayoutTransition) => void;
    const first = vi.fn(() => new Promise<PreparedLayoutTransition>((resolve) => {
      resolveFirst = resolve;
    }));
    const secondReceipt = prepared("layout-2");
    const second = vi.fn(async () => secondReceipt);

    await act(async () => root.render(<Probe prepare={first} />));
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace",
      revision: 1,
      from: arrangement(false),
      to: arrangement(true),
    })).toBe(true);
    const claimedFirst = claimLayoutTransitionIntent("workspace", 1);
    expect(claimedFirst).not.toBeNull();

    await act(async () => root.render(<Probe prepare={second} />));
    const firstReceipt = prepared("layout-1");
    resolveFirst(firstReceipt);
    await expect(claimedFirst).resolves.toBe(firstReceipt);
    expect(firstReceipt.cancel).not.toHaveBeenCalled();

    expect(finishLayoutTransitionIntent("workspace", 1, {
      reason: "committed",
      transactionId: "layout-1",
    })).toBe(true);
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace",
      revision: 2,
      from: arrangement(true),
      to: arrangement(false),
    })).toBe(true);
    await expect(claimLayoutTransitionIntent("workspace", 2)).resolves.toBe(secondReceipt);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
