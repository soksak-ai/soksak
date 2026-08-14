// Activity backfill — starts with nothing when there is nothing.
//
// At boot the orchestrator fills the past from activity_recent and then continues with the live subscription.
// The backfill is a **convenience** and the subscription is the body — even with no backfill the feed grows
// correctly from that moment on.
//
// Measured (2026-07-28, Electron live activity ledger): that call was rejected and an unhandledrejection followed.
// The rejection itself is correct (the ring buffer is the app process's, so this process cannot answer, and that
// reason is written in the table). What is wrong is that the caller never received that answer.
//
// Do not swallow it. Swallowing hides "why is the backfill empty" forever — making absence and failure the same
// value sends the next person to investigate the same spot again. So start with an empty feed and keep the reason.
import { describe, expect, it } from "vitest";
import { backfillFeed } from "./activityBackfill";

describe("activity backfill", () => {
  it("fills the feed with the answer as given", async () => {
    const entries = [{ seq: 1 }, { seq: 2 }];
    const noted: string[] = [];
    const out = await backfillFeed(async () => entries, (m) => noted.push(m));
    expect(out).toBe(entries);
    expect(noted).toEqual([]);
  });

  it("starts with an empty feed on a rejection and keeps the reason", async () => {
    const noted: string[] = [];
    const out = await backfillFeed(
      async () => {
        throw new Error("activity_recent is not served by this process — the ring buffer…");
      },
      (m) => noted.push(m),
    );
    expect(out).toEqual([]);
    expect(noted).toHaveLength(1);
    // The reason is included verbatim — summarizing erases the evidence written in the table.
    expect(noted[0]).toContain("activity_recent");
    expect(noted[0]).toContain("ring buffer");
  });

  // Not throwing is the point — throwing leaves an unhandledrejection on the boot path.
  it("never throws, whatever the failure is", async () => {
    await expect(
      backfillFeed(async () => {
        throw new Error("anything");
      }, () => {}),
    ).resolves.toEqual([]);
  });

  it("a non-array answer is an empty feed too — an answer of another shape is not passed through", async () => {
    const noted: string[] = [];
    const out = await backfillFeed(async () => ({ nope: true }) as never, (m) => noted.push(m));
    expect(out).toEqual([]);
    expect(noted).toHaveLength(1);
  });
});
