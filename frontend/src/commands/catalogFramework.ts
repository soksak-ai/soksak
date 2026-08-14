// framework.* — the surface that reads from outside which framework (Tauri, Electron) this app runs on now.
//
// Not "shell" — that word names the login shell (zsh, bash), and this repository treats PTY and terminal as
// core (login_shell.rs, --login-shell, shell_which). Not "platform" either — that one is the OS.
//
// The framework is behind an adapter (src/framework), and that boundary keeps framework details out of app
// code. Diagnostics, harnesses, and ledgers still need it — without an answer to "which framework did this
// happen on", evidence from two frameworks piles up mixed. The contract already holds the name
// (AppFramework.name); this command emits it.
//
// Capabilities are read by **presence only**. An unimplemented capability is built to throw with its name the
// moment it is called (the adapter's unimplemented), so a query that invokes one shakes the app.

import { framework } from "../framework";
import { titlebarProvisionBreaches } from "../framework/titlebarProvision";
import { tmsg } from "../i18n";
import { register } from "./registry";

/** Names of the contract capabilities — nested groups (app, path, dialog, notification, deepLink) are
 *  flattened to dotted paths. Values are read only (never invoked). name is identity, not a capability, so it is excluded. */
function capabilityNames(framework: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(framework)) {
    if (key === "name") continue;
    const value = framework[key];
    if (typeof value === "function") out.push(key);
    else if (value && typeof value === "object") {
      for (const sub of Object.keys(value as object)) out.push(`${key}.${sub}`);
    }
  }
  // Deterministic order — if the order shifts, comparing ledgers from outside shows a false difference.
  return out.sort();
}

export function registerFrameworkCatalog(): void {
  register("framework.info", {
    description:
      "Read which app framework this window actually runs on (the resolved adapter, e.g. tauri or electron) and which contract capabilities that adapter exposes. Capability names are reported by presence only — nothing is invoked, because an unimplemented capability throws when called. Use when diagnosing an incident, driving a harness, or stamping a ledger entry with the framework it came from.",
    triggers: { ko: "프레임워크 어댑터 플랫폼 활성 런타임 진단 능력 어느프레임워크" },
    params: {},
    returns:
      "{ framework, capabilities[], titlebarComposition, titlebarBreaches[] } — the active adapter name, the contract capability names it exposes (nested groups flattened as group.member), this framework's own declaration about window-control (traffic light) composition, and the calls it declared as provided yet refused.",
    message: (d) =>
      tmsg("msg.framework.info", {
        framework: String(d.framework ?? ""),
        n: Array.isArray(d.capabilities) ? d.capabilities.length : 0,
      }),
    examples: ["framework.info"],
    handler: () => ({
      framework: framework.name,
      capabilities: capabilityNames(framework as unknown as Record<string, unknown>),
      // Traffic-light composition cannot be read by presence alone — for a missing facet the **reason** is the
      // answer. The verdict must read that declaration so nothing branches on the framework name.
      titlebarComposition: framework.titlebarComposition,
      // Places where declaration and behavior diverged. Empty differs from unmeasured, so it is always emitted (an empty array is an answer too).
      titlebarBreaches: titlebarProvisionBreaches(),
    }),
  });
}
