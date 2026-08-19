// State of the observation wiring — registered at the end of registerCatalog() (catalog split —
// catalogProjection precedent).
//
// The envelope's degraded is a summary and reports only whether something is degraded. Which
// axis, since when, and how takes counters, and without counters a fix cannot be proven — so
// there is a separate place to query.

import { key, tmsg } from "../i18n";
import { register } from "./registry";
import { catalogJson } from "./registry";
import { commandHealth, noteActivityPersist, noteLedgerAudit } from "./commandObservation";
import { useUi } from "../state/ui";
import { preferenceStoreContents, preferenceWriteFailures } from "../lib/preferenceStore";
import { invoke } from "../framework";

export function registerHealthCatalog(): void {
  register("state.health", {
    description: key("cmd.state.health.desc"),
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
        // The document's own account of its start. The boot script records a failure on the
        // document element and in the console, and neither is a reading: on 2026-08-17 `<html>`
        // carried data-boot-status="failed" while `activity.recent` held zero renderer errors, and
        // the only way anyone learned it was by opening an inspector.
        boot: {
          status: document.documentElement.dataset.bootStatus ?? "",
          error: document.documentElement.dataset.bootError ?? "",
          runtimeError: document.documentElement.dataset.runtimeError ?? "",
        },
      };
    },
  });

  // What the window has written to the synchronous store it reads at boot.
  //
  // The store is a cache — the authority is the core's — but it is a shared, bounded one, and a
  // quota spent by something is a quota unavailable to everything. Measured 2026-08-19: it was
  // full, a sidebar drag threw `QuotaExceededError` out of a React commit, and the window went
  // blank. What was in it could not be asked: the boot error named `setItem` and nothing named the
  // keys. So the sizes are a reading, and the biggest is first because that is the question.
  register("state.storage", {
    description: key("cmd.state.storage.desc"),
    triggers: { ko: "로컬 저장소 용량 키 크기 할당량 초과 설정 저장 실패" },
    params: {},
    returns: "{ totalChars, keys[].{key,chars}, failures[].{key,reason,atUnixMs} }",
    message: (d) =>
      tmsg("msg.state.storage", {
        n: ((d.keys as unknown[]) ?? []).length,
        chars: Number(d.totalChars ?? 0),
      }),
    examples: ["state.storage"],
    handler: () => ({
      ...preferenceStoreContents(),
      // Which writes did not land. Read from the same place the health verdict reads, so the two
      // cannot disagree about whether this window is still remembering anything.
      failures: preferenceWriteFailures(),
    }),
  });
}
