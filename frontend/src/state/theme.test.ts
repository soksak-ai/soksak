// The core does not call what a framework declares absent, and does not swallow the rejection of what it declares present.
//
// Former site (theme.ts): it called `titlebar_backing` unconditionally on every framework and swallowed
// everything with `.catch(() => {})`. Electron declared the concept absent and wrote down the reason, but
// the core never read that declaration, and no rejection remained, so "declared, yet nothing happens" showed up nowhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitlebarCompositionProvision } from "../framework/contract";

const absent = (reason: string) => ({ provided: false as const, reason });
const provided = { provided: true as const };

const harness = vi.hoisted(() => ({
  provision: {
    buttonPositions: { provided: false as const, reason: "no public button rect" },
    backingPlane: { provided: false as const, reason: "no backing plane" },
    paintOwner: { provided: false as const, reason: "no paint owner ledger" },
  } as TitlebarCompositionProvision,
  invoked: [] as { cmd: string; args?: Record<string, unknown> }[],
  reject: null as string | null,
  themeModes: [] as string[],
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  titlebarComposition: harness.provision,
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    harness.invoked.push({ cmd, args });
    if (cmd === "titlebar_backing" && harness.reject !== null) {
      return Promise.reject(new Error(harness.reject));
    }
    if (cmd === "themes_scan") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
  currentWindow: () => ({
    setTheme: (mode: string) => {
      harness.themeModes.push(mode);
      return Promise.resolve();
    },
  }),
}));

import { useTheme } from "./theme";
import {
  clearTitlebarProvisionBreaches,
  titlebarProvisionBreaches,
} from "../framework/titlebarProvision";

function setProvision(next: TitlebarCompositionProvision): void {
  Object.assign(harness.provision, next);
}

/** Minimal stimulus that forces the declaration to be read again: one user action (mode toggle). */
function retheme(): void {
  useTheme.getState().toggleMode();
}

beforeEach(() => {
  harness.invoked.length = 0;
  harness.themeModes.length = 0;
  harness.reject = null;
  clearTitlebarProvisionBreaches();
});

afterEach(() => {
  clearTitlebarProvisionBreaches();
});

describe("theme reads the traffic-light backing declaration", () => {
  it("does not call it on a framework that declares no backing plane", () => {
    setProvision({
      buttonPositions: absent("no public button rect"),
      backingPlane: absent("no backing plane"),
      paintOwner: absent("no paint owner ledger"),
    });
    retheme();
    expect(harness.invoked.map((c) => c.cmd)).not.toContain("titlebar_backing");
    // A declared absence is not a breach. Nothing is recorded in the ledger.
    expect(titlebarProvisionBreaches()).toEqual([]);
    // Window chrome brightness is a separate axis, so keep syncing it.
    expect(harness.themeModes.length).toBeGreaterThan(0);
  });

  it("calls it with the color on a framework that declares a backing plane", () => {
    setProvision({
      buttonPositions: provided,
      backingPlane: provided,
      paintOwner: provided,
    });
    retheme();
    const call = harness.invoked.find((c) => c.cmd === "titlebar_backing");
    expect(call).toBeDefined();
    for (const key of ["r", "g", "b"]) {
      const channel = call!.args?.[key];
      expect(typeof channel).toBe("number");
      expect(channel as number).toBeGreaterThanOrEqual(0);
      expect(channel as number).toBeLessThanOrEqual(1);
    }
  });

  it("records a declared axis that was refused by name instead of swallowing it", async () => {
    setProvision({
      buttonPositions: provided,
      backingPlane: provided,
      paintOwner: provided,
    });
    harness.reject = "Command titlebar_backing not found";
    retheme();
    await Promise.resolve();
    await Promise.resolve();
    expect(titlebarProvisionBreaches()).toEqual([
      {
        facet: "backingPlane",
        command: "titlebar_backing",
        error: "Command titlebar_backing not found",
      },
    ]);
  });
});
