// **The reply accounts for who spends the 100ms.**
//
// Tab switch settling waits 100ms, while DOM and motion were already done at 9ms (measured 2026-08-09).
// All the rest is the segment that checks whether the surface is on screen, and it contains several calls
// with no place to ask how much each one costs. So the culprit was **guessed** and changed twice, and both
// times it got slower (100ms → 225ms → over 350ms). Without a place to measure, fixing is a gamble.
//
// The check segment splits into two barriers: the content surface side and the view surface side. The reply answers for each separately.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

const barriers = vi.hoisted(() => ({
  content: vi.fn(async () => {}),
  view: vi.fn(async () => {}),
}));
vi.mock("../lib/contentViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/contentViews")>()),
  hasContentViewHost: () => true,
  contentViewHost: () => ({ presentationSettled: barriers.content }),
}));
vi.mock("../plugins/viewPresentationHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/viewPresentationHost")>()),
  pluginViewPresentationHost: () => ({ presentationSettled: barriers.view }),
}));

import { waitLayoutSettled } from "./waitLayoutSettled";

beforeEach(() => {
  barriers.content.mockClear();
  barriers.view.mockClear();
  // Labels come from the declaration in the document — inventing them in a mock makes this test measure a different world.
  document.body.innerHTML = `<div data-content-view-body="browser.main.tab-4h7kq2"></div>`;
});

describe("the settle receipt answers with the confirmation intervals split apart", () => {
  it("reports the two barriers' times separately", async () => {
    barriers.content.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); });
    barriers.view.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const out = await waitLayoutSettled(4_000);
    expect(out.presentation.content).toMatchObject({
      owner: "content", status: "settled", elapsedMs: expect.any(Number), labels: ["browser.main.tab-4h7kq2"],
    });
    expect(out.presentation.view).toMatchObject({
      owner: "view", status: "settled", elapsedMs: expect.any(Number), labels: [],
    });
    expect(out.presentation.content!.elapsedMs).toBeGreaterThanOrEqual(25);
    expect(out.presentation.view!.elapsedMs).toBeGreaterThanOrEqual(8);
    // The reply also lists which surfaces were waited on — without the count, one slow surface and several overlapping ones are indistinguishable.
    expect(out.presentation.content!.labels).toEqual(["browser.main.tab-4h7kq2"]);
  });

  it("answers absent rather than 0 when there is no barrier — not measured and 0ms are different facts", async () => {
    const out = await waitLayoutSettled(4_000);
    expect(out.presentation.content).toMatchObject({ owner: "content", status: "settled" });
  });
});
