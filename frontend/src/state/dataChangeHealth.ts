// Counts the **arrival** of store change notifications — counting only the sending side is half the fact.
//
// Notifications cross processes (A22 notification axis): the store owner broadcasts and the window-holding
// processes receive. A broken path raises no error — the receiver takes its stale value for the truth and
// overwrites another process's change on the next save. To see that loss, "did it arrive" must be a value you can query.
//
// A count of 0 is not health, it is **unverified**: a process with the wiring missing entirely must not
// look the same as a process where nobody has changed anything yet.
import { moduleState } from "../lib/moduleState";

const box = moduleState("state/dataChangeHealth#received", () => ({
  count: 0,
  lastAt: 0,
  lastNs: "",
  lastOp: "",
}));

/** One notification arrived. The receiving end of the subscription wiring calls this. */
export function noteDataChange(ns: string, op: string): void {
  box.count += 1;
  box.lastAt = Date.now();
  box.lastNs = ns;
  box.lastOp = op;
}

/** Arrival status — `state.health` puts this in its reply. */
export function dataChangeHealth(): Record<string, unknown> {
  return {
    received: box.count,
    lastAt: box.lastAt || null,
    lastNs: box.lastNs || null,
    lastOp: box.lastOp || null,
  };
}
