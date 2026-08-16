// The seam between quitting and this window's record.
//
// The autosave is debounced and subscribed to sessions changes, so it catches what happens after
// boot installs it. A workspace created *during* boot is never saved by a subscription, and
// `pagehide` — the only other trigger — fires as the process is going, so the asynchronous write
// races the exit and loses.
//
// Measured 2026-08-16 in an isolated home: a workspace window was opened, the application was quit
// through `app.shutdown.commit`, and the store held no `windows` ledger and no `window/<label>`
// snapshot. Nothing reported it; the window simply did not come back.
//
// So quitting waits for the record. This module is the wait, and it is a seam rather than a direct
// call because the save is inside one window's boot closure and the quit is a command in the
// catalog — a direct import would put the manner of persistence into the catalog.

import { moduleState } from "../lib/moduleState";

/** The save this window registered, or null before its boot installs one. */
const ms = moduleState("state/windowPersistRequest#state", () => ({
  save: null as (() => Promise<void>) | null,
}));

/** Registers the save this window performs on demand.
 *
 *  One window, one save: a second registration replaces the first rather than adding to it, because
 *  two saves of one window would write the same record twice and the later write is not newer. */
export function onWindowPersist(save: (() => Promise<void>) | null): void {
  ms.save = save;
}

/** Waits until this window's record is in the store.
 *
 *  Answers at once where no save is registered — the orchestrator before its boot, or a build with
 *  no persistence — because that is not a reason to refuse a quit.
 *
 *  A save that throws is reported and does not hold the quit. A process that will not exit because
 *  its record could not be written is worse than the lost record, and the reaping still has to run. */
export async function persistWindowNow(): Promise<void> {
  const save = ms.save;
  if (!save) return;
  try {
    await save();
  } catch (e) {
    console.error("the window record could not be written before quitting:", e);
  }
}
