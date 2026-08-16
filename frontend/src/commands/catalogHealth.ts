// State of the observation wiring — registered at the end of registerCatalog() (catalog split —
// catalogProjection precedent).
//
// The envelope's degraded is a summary and reports only whether something is degraded. Which
// axis, since when, and how takes counters, and without counters a fix cannot be proven — so
// there is a separate place to query.

import { tmsg } from "../i18n";
import { register } from "./registry";
import { catalogJson } from "./registry";
import { commandHealth, noteActivityPersist, noteLedgerAudit } from "./commandObservation";
import { useUi } from "../state/ui";
import { invoke } from "../framework";

export function registerHealthCatalog(): void {
  register("state.health", {
    description:
      "Report the liveness of the core's observation wiring: command registry size, execution trace sink, and activity hub publishing (attempts/ok/failed/consecutive/lastError/lastStampAt). Use this when responses look fine but nothing is being recorded.",
    triggers: { ko: "상태 진단 건강 관측 배선" },
    params: {},
    returns:
      "{ ready, commands{registered,traceSinkInstalled,emitted,lastEmitAt}, activity{...}, persist{...}, degradedAxes, ledger{minSeq,maxSeq,gaps,timeRegressions,singleWriter,persist} — ledger comes from cored; two processes write the store, so one side alone is not a verdict }",
    message: (d) =>
      tmsg("msg.state.health", {
        n: ((d.degradedAxes as unknown[]) ?? []).length,
      }),
    examples: ["state.health"],
    // Apart from symptoms attached to every query (envelope degraded), a place to query must
    // exist. A summary alone cannot count which axis limps since when and how, and without
    // counting a fix cannot be proven.
    handler: async () => {
      // Core-side counters take a query — the framework returns the persist state of its own process.
      try {
        noteActivityPersist(
          (await invoke<Record<string, number>>("activity_persist_stats")) ?? {},
        );
      } catch {
        // A failed query still reports the other axes — one silent axis does not block the whole diagnosis.
      }
      // The registry supplies the registered count — the observation module has no access to the
      // registry (neither reads the other's internals). With two processes writing the store, one
      // side's state alone proves nothing — cored's ledger state is returned too (a query, so the
      // round trip is safe: this is not the publish path).
      let ledger: Record<string, unknown> | null = null;
      try {
        ledger = await invoke<Record<string, unknown>>("activity_audit");
      } catch (e) {
        ledger = { unreachable: e instanceof Error ? e.message : String(e) };
      }
      // Record it before the verdict — recorded later, that turn's degraded excludes the ledger.
      noteLedgerAudit(ledger);
      // Overlays decide whether anything is drawn at all: a native surface is composited above the
      // document, so `surfaceShown` hides every view while one is open. A count nothing can read is
      // a reason for a blank window that nobody can name — measured 2026-08-17, the manager closed
      // and every pane stayed empty.
      return {
        ...commandHealth(catalogJson().length),
        ledger,
        overlays: useUi.getState().overlayCount,
      };
    },
  });

}
