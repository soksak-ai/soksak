// runtimeDep — *pure decision* logic for external runtime dependencies(4-tuple). No IO(no app/disk) → unit testable.
//   classifyHealth: Observed → one of 5 Health states. accept: Health → accepted or not. nextAction: Health → action.
// IO(observe = probe/disk inspection, reach = install/download/cleanup) is run by the reconcile engine(M3, core boundary).
import { semverGte, type LibraryDep, type ProgramPlatform } from "./spec";

export type Health =
  | "ABSENT"
  | "PARTIAL"
  | "BROKEN"
  | "VERSION_MISMATCH"
  | "HEALTHY";

// Observation result — the core(M3) fills it from disk/probe. Input of the pure classification.
export interface Observed {
  present: boolean; // bin exists on PATH
  working: boolean; // probe argv exits 0 (actually runs)
  partial: boolean; // install traces (lib) exist but bin is unlinked — the state behind EEXIST
  broken: boolean; // dangling symlink / integrity failure
  version?: string; // version the probe extracted
}

// "present == working" is dropped — classify the observation into 5 states. partial/broken first(repair targets).
export function classifyHealth(o: Observed, minVersion?: string): Health {
  if (o.partial) return "PARTIAL";
  if (o.broken) return "BROKEN";
  if (!o.present) return "ABSENT";
  if (!o.working) return "BROKEN";
  if (minVersion && o.version && semverGte(o.version, minVersion) !== true) {
    return "VERSION_MISMATCH";
  }
  return "HEALTHY";
}

// Accept predicate — HEALTHY only. An empty diff(=accept) is the same proof of correctness and idempotence.
export function accept(health: Health): boolean {
  return health === "HEALTHY";
}

// probe stdout → version(pure). observe.versionRe extracts the "actual" version(capture group 1 first, else the whole match).
// Without versionRe there is no extraction(undefined) → classifyHealth skips the minVersion comparison(presence only).
export function parseProbeVersion(
  stdout: string,
  versionRe?: string,
): string | undefined {
  if (!versionRe) return undefined;
  const m = new RegExp(versionRe).exec(stdout);
  if (!m) return undefined;
  return m[1] ?? m[0];
}

export type ReconcileAction = "noop" | "reach" | "cleanup-then-reach";

// Decision of the idempotent reconcile(pure): HEALTHY=no action, PARTIAL/BROKEN=cleanup then supply, otherwise=supply.
// The engine branches on the diff(accept or not), never on action kind — cleanup of PARTIAL/BROKEN removes the root of EEXIST.
export function nextAction(health: Health): ReconcileAction {
  switch (health) {
    case "HEALTHY":
      return "noop";
    case "PARTIAL":
    case "BROKEN":
      return "cleanup-then-reach";
    case "ABSENT":
    case "VERSION_MISMATCH":
      return "reach";
  }
}

// Supply(reach) execution kinds — the IO engine(reconcileDependencies) runs them as-is.
export type ReachExec =
  | { kind: "command"; command: string } // install command via process_spawn/terminal
  | { kind: "vendor"; vendorPath: string; sha256: string } // link after sha256 check of the author-bundled bytes
  | { kind: "fetch"; url: string; sha256: string }; // download_verify (download + sha256)

export interface ReconcileStep {
  action: ReconcileAction;
  reach?: ReachExec; // present only when action !== noop
}

// dep + Observed → reconcile step(pure): action(noop/reach/cleanup-then-reach) + reach execution kind.
// reach precedence: reach.vendor/fetch/command > legacy install. No supply means for this platform → noop.
export function reconcilePlan(
  dep: LibraryDep,
  observed: Observed,
  platform: ProgramPlatform,
): ReconcileStep {
  const health = classifyHealth(observed, dep.accept?.minVersion);
  if (accept(health)) return { action: "noop" };
  const reach = reachExec(dep, platform);
  if (!reach) return { action: "noop" }; // no supply means on this platform → never forced (§0-4)
  return { action: nextAction(health), reach };
}

function reachExec(dep: LibraryDep, platform: ProgramPlatform): ReachExec | null {
  const r = dep.reach;
  if (r) {
    if ("vendor" in r) {
      return { kind: "vendor", vendorPath: r.vendor.path, sha256: r.vendor.sha256 };
    }
    if ("fetch" in r) {
      const url = r.fetch.url[platform];
      const sha256 = r.fetch.sha256[platform];
      return url && sha256 ? { kind: "fetch", url, sha256 } : null;
    }
    if ("command" in r) {
      const command = r.command[platform];
      return command ? { kind: "command", command } : null;
    }
  }
  const command = dep.install[platform];
  return command ? { kind: "command", command } : null;
}
