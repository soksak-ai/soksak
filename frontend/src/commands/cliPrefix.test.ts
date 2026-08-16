// The prefix (sok/sok-dev/sok-debug) is not data but the identity of the presenter. Catalog examples and
// runtime hints hold the command shape only; this app's CLI name is attached at the display point. Two axes
// pin that contract:
//  (1) No catalog example starts with a binary token — recurrence guard (blocks the multi-env listing from returning).
//  (2) Reply hints are stamped with this app's CLI name at run time — a dev app's suggestion must run as sok-dev to hit the dev socket.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogJson, execute } from "./registry";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { __setCliNameForTest, cliName } from "../lib/cliIdentity";

// Only when the first token is exactly sok / sok-dev / sok-debug — other names such as soksak-* and mid-sentence occurrences are excluded.
const LEADING_BIN = /^sok(-dev|-debug)?( |$)/;

beforeAll(() => {
  // Same registration sequence as executor.startExecutor — puts the whole core surface (plus dev) in the catalog.
  registerCatalog();
  registerRemoteCatalog();
  registerRemoteConfirmDevCatalog();
  registerDebugCatalog();
});

describe("CLI prefix is presenter identity, not data", () => {
  it("no catalog example starts with a binary token", () => {
    const offenders: string[] = [];
    for (const spec of catalogJson()) {
      for (const ex of spec.examples) {
        if (LEADING_BIN.test(ex)) offenders.push(`${spec.name}: ${ex}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the default CLI name is sok — before the boot load, and as the non-Tauri fallback", () => {
    expect(cliName()).toBe("sok");
  });
});

describe("runtime hints are stamped with this app CLI name", () => {
  afterEach(() => __setCliNameForTest("sok"));

  it("the standard error hint is prefixed with this app name", async () => {
    __setCliNameForTest("sok-dev");
    // Unknown command → UNKNOWN_COMMAND → the standard guidance hint (shape only) is stamped at the central point.
    const r = await execute("definitely.not.a.real.command", {}, {});
    expect(r.ok).toBe(false);
    expect(r.hint?.length ?? 0).toBeGreaterThan(0);
    for (const h of r.hint ?? []) {
      expect(h.cmd.startsWith("sok-dev ")).toBe(true);
    }
  });

  it("the release app prefixes the same hint with sok", async () => {
    __setCliNameForTest("sok");
    const r = await execute("definitely.not.a.real.command", {}, {});
    for (const h of r.hint ?? []) {
      expect(h.cmd.startsWith("sok ")).toBe(true);
      expect(h.cmd.startsWith("sok-")).toBe(false);
    }
  });
});
