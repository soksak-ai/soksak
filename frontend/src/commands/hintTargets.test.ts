// hint target rot gate — calls spec.hint across the whole catalog (core + plugin management +
// remote) with success and failure shapes, and asserts that the first token after "sok " in each
// resulting cmd string points at an existing target.
// A hint offers a possibility (the offer philosophy) — if the destination of that offer is dead,
// the offer itself is false guidance. When a command is renamed or deleted, a hint aimed at it
// fails this gate immediately.

import { describe, expect, it, vi } from "vitest";

// On import, catalog goes through the zustand persist middleware and touches localStorage (same stub as layoutApply.test and others).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { registerRemoteCatalog } from "./catalogRemote";
import { catalogJson, getSpec, type CommandHint } from "./registry";

registerCatalog(); // core + plugin.* + ui.* + dom.* in full (registerPluginCatalog/registerDomCatalog included).
registerRemoteCatalog(); // remote.confirm — a command registered separately, outside registerCatalog().

const ALL_NAMES = new Set(catalogJson().map((c) => c.name));

// ② Top-level auxiliary subcommands and flags the CLI handles directly, without the registry.
const CLI_AUX = new Set(["commands", "help", "docs", "--window"]);

// Probes hint with several success-shaped and failure-shaped data. CONSENT_REQUIRED also exercises
// the data.pendingConsent branch of plugin.enable (precise cmd with structured data, empty-array fallback without it — both must be safe).
const PROBE_DATA: Record<string, unknown>[] = [
  {},
  { code: "TARGET_NOT_FOUND", message: "no such target" },
  { code: "INVALID_PARAMS", message: "bad value" },
  {
    code: "CONSENT_REQUIRED",
    message: "enabling soksak-plugin-y needs consent for soksak-plugin-x and soksak-plugin-y",
    data: { pendingConsent: ["soksak-plugin-x", "soksak-plugin-y"] },
  },
  { code: "CONSENT_REQUIRED", message: "enabling soksak-plugin-x needs consent" },
];

// First token after "sok " — a command name, or a CLI auxiliary subcommand/flag.
function firstToken(cmd: string): string | null {
  const m = /^sok\s+(\S+)/.exec(cmd.trim());
  return m ? m[1] : null;
}

describe("hint target rot gate", () => {
  it("every spec.hint cmd names one of ① an existing command ② a CLI auxiliary subcommand ③ a dynamic plugin.* name", () => {
    const offenders: string[] = [];
    for (const name of ALL_NAMES) {
      const spec = getSpec(name);
      if (!spec?.hint) continue; // a spec with no hint is not a target.
      for (const data of PROBE_DATA) {
        let hints: CommandHint[];
        try {
          hints = spec.hint(data, {});
        } catch {
          continue; // an exception skips only that spec in this probe (the same tolerance as registry.execute).
        }
        for (const h of hints) {
          const token = firstToken(h.cmd);
          if (!token) continue; // a cmd that does not start with "sok " is outside this gate.
          const known =
            ALL_NAMES.has(token) || CLI_AUX.has(token) || token.startsWith("plugin.");
          if (!known) offenders.push(`${name} → "${h.cmd}"(token "${token}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every declared hint runs without throwing for at least one probe", () => {
    // An exception thrown by hint itself is skipped silently by the gate above, but skipping such a
    // spec with no measurement makes the gate empty — at least one probe (the success shape {}) must pass.
    const alwaysThrows: string[] = [];
    for (const name of ALL_NAMES) {
      const spec = getSpec(name);
      if (!spec?.hint) continue;
      let allThrew = true;
      for (const data of PROBE_DATA) {
        try {
          spec.hint(data, {});
          allThrew = false;
        } catch {
          /* try the next probe */
        }
      }
      if (allThrew) alwaysThrows.push(name);
    }
    expect(alwaysThrows).toEqual([]);
  });
});
