// Renderer error ledger — a silent failure is never permitted (user decision 2026-07-27).
// A React render exception commits asynchronously, so the try/catch at the mount call site cannot catch it and
// it dies in the console only (real incident: a browser view left an empty absolute wrapper and stayed silent —
// the screen was blank space, the ledger was mute).
// window error/unhandledrejection are published to the activity hub (renderer.error) so that any exception in
// any window is machine-readable through `sok events --kinds renderer.error`. A publish failure is swallowed
// (observation must not block the body). A repeated identical message is capped at 8 per window (runaway
// suppression — 1 instance of the cause is enough, and reaching the cap is recorded too).
import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";

// Outside the hot-swap boundary — a replaced map would stay empty: the filling side has already
// recorded the fill and does not fill again.
const seen = moduleState("lib/errorLedger#seen", () => new Map<string, number>());
const CAP = 8;

function publish(kind: "error" | "unhandledrejection", message: string, stack: string | null): void {
  const key = `${kind}:${message}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  if (n > CAP) return;
  void invoke("activity_publish", {
    kind: "renderer.error",
    source: "renderer",
    payload: {
      errorKind: kind,
      error: message.slice(0, 400),
      stack: stack?.slice(0, 1200) ?? null,
      repeat: n,
      capped: n === CAP,
      origin: "internal",
      message: `· renderer ${kind}: ${message.slice(0, 120)}`,
    },
  }).catch(() => {});
}

// The record of "already attached" must cross the hot swap boundary — if only this flag disappears, the install
// is gone while the filling side skips reattaching because it recorded the run (never installed).
const installedFlag = moduleState("lib/errorLedger#installedFlag.on", () => ({ on: false }));

export function installErrorLedger(): void {
  if (installedFlag.on || typeof window === "undefined") return;
  installedFlag.on = true;
  window.addEventListener("error", (e) => {
    const err = e.error as Error | undefined;
    publish("error", String(err?.message ?? e.message ?? "unknown"), err?.stack ?? null);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    publish("unhandledrejection", String(r?.message ?? e.reason ?? "unknown"), r?.stack ?? null);
  });
}
