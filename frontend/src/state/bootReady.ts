import { tmsg } from "../i18n";
import { useBootPhase } from "./bootPhase";

/** Bounded barrier that waits for the boot phase ready event without polling. */
export function awaitBootReady(timeoutMs = 30_000): Promise<{ phase: "ready" }> {
  if (useBootPhase.getState().phase === "ready") return Promise.resolve({ phase: "ready" });
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve({ phase: "ready" });
    };
    const timer = setTimeout(
      () => finish(new Error(tmsg("msg.app.boot.wait.timeout", { ms: timeoutMs }))),
      timeoutMs,
    );
    unsubscribe = useBootPhase.subscribe((state) => {
      if (state.phase === "ready") finish();
    });
    // Closes the race with a ready transition that lands just before subscribe.
    if (useBootPhase.getState().phase === "ready") finish();
  });
}
