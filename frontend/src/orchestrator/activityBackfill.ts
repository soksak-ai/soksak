// Activity backfill — fill the past once, then continue with the live subscription.
//
// The backfill is a **convenience**; the subscription is the real mechanism. Without a backfill the feed
// still grows correctly from that moment on, so a failed backfill is no reason to block boot — throwing
// leaves an unhandledrejection on the boot path, and that one line stains the ledger and hides the real defect (measured 2026-07-28).
//
// It is not swallowed either. Swallowing hides why the backfill was empty, makes "absent" and "failed" the
// same value, and the next person investigates the same spot again. Keep the reason verbatim — the framework
// records why it refuses (cored UNSERVED), and that sentence is the answer.

/** One backfill. On failure it does not throw and returns an empty feed. */
export async function backfillFeed<T>(
  load: () => Promise<T[]>,
  note: (reason: string) => void,
): Promise<T[]> {
  try {
    const entries = await load();
    if (!Array.isArray(entries)) {
      note(`activity backfill skipped — answer is not an array: ${JSON.stringify(entries)?.slice(0, 200)}`);
      return [];
    }
    return entries;
  } catch (e) {
    note(`activity backfill skipped — ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
