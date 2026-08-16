// @vitest-environment jsdom
// A window's record is in the store before the process is allowed to go.
//
// The autosave is debounced and subscribed to sessions changes, so it catches
// what happens after boot installs it. A workspace created *during* boot is
// therefore never saved by a subscription, and a window opened and left alone
// has no record at all.
//
// `pagehide` was the only other trigger. It fires as the process is going and the
// write is asynchronous, so the record raced the exit and lost — measured
// 2026-08-16 in an isolated home: a workspace window was opened, the application
// was quit through `app.shutdown.commit`, and the store held no `windows` ledger
// and no `window/<label>` snapshot. Nothing reported it; the window simply did
// not come back.
//
// So quitting waits for the record. `persistWindowNow` is that wait, and the one
// quit path calls it before it reaps.
import { beforeEach, expect, it, vi } from "vitest";

import { onWindowPersist, persistWindowNow } from "./windowPersistRequest";

beforeEach(() => {
  onWindowPersist(null);
});

it("waits for the window that registered a save", async () => {
  let landed = false;
  let release!: () => void;
  const written = new Promise<void>((resolve) => { release = resolve; });
  onWindowPersist(async () => {
    await written;
    landed = true;
  });

  const waiting = persistWindowNow();
  expect(landed, "the quit went ahead before the record landed").toBe(false);
  release();
  await waiting;
  expect(landed).toBe(true);
});

// A window that never registered one — the orchestrator before its boot, or a
// build with no persistence — is not a reason to refuse the quit.
it("answers at once when no window registered a save", async () => {
  await expect(persistWindowNow()).resolves.toBeUndefined();
});

// A save that throws must not hold the quit for ever. The failure is reported
// and the quit proceeds: a process that will not exit because its record could
// not be written is worse than the lost record, and the reaping still has to run.
it("does not hold the quit when the save fails", async () => {
  const reported: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void reported.push(args));
  onWindowPersist(async () => {
    throw new Error("the store refused");
  });

  await expect(persistWindowNow()).resolves.toBeUndefined();
  expect(reported.length).toBeGreaterThan(0);
});
