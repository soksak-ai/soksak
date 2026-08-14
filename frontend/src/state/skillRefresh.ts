// Skill auto-regeneration trigger — when the enabled plugin set (= the command surface) changes, spawn the CLI
// per the identity home manifest and rewrite SKILL.md (P8 write-through: own the file, do not intercept it).
// No polling: the zustand subscription is the signal source, and the debounce folds a reload storm into one run.
import { invoke } from "../framework";
import { usePlugins } from "./plugins";

/** Enabled-set fingerprint — sorted join of the enabled plugin ids. Same surface, same fingerprint (pure). */
export function enabledFingerprint(plugins: Record<string, { status: string }>): string {
  return Object.entries(plugins)
    .filter(([, p]) => p.status === "enabled")
    .map(([id]) => id)
    .sort()
    .join(",");
}

export function initSkillRefresh(): void {
  let last = enabledFingerprint(usePlugins.getState().plugins);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    void invoke("skill_refresh_spawn").catch(() => {
      /* A failed skill regeneration does not block the app — the next change or install retries it */
    });
  };
  usePlugins.subscribe((s) => {
    const now = enabledFingerprint(s.plugins);
    if (now === last) return;
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, 3000); // coalesce a burst of activations (boot, full reload) into one call
  });
}
