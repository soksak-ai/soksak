// Pins the program registry contract — registration conflicts, and the split of run and install commands.
// Run (autorun) uses command verbatim (no wrapping — prevents the incident where a one-liner
// shows up in the terminal); install (ensure) is enable-time work (supplied by installCommandFor).
import { describe, expect, it } from "vitest";
import {
  autorunCommandOf,
  installCommandFor,
  useProgramRegistry,
} from "./programRegistry";
import type { ContributedProgram } from "./spec";

// Every program is kind:"view" (core terminal removed — the terminal is a plugin view too). A view program may
// come with command/ensure (agent program: terminal plugin view + autorun command + install).
const prog = (id: string, extra: Partial<ContributedProgram> = {}): ContributedProgram => ({
  id,
  title: id,
  kind: "view",
  view: "content",
  ...extra,
});

describe("programRegistry — registration discipline", () => {
  it("a global id collision is an error at registration time (§0-3)", () => {
    const off = useProgramRegistry.getState().register("p1", prog("dup"));
    try {
      expect(() =>
        useProgramRegistry.getState().register("p2", prog("dup")),
      ).toThrow(tmsg("plugin.program.duplicateId", { id: "dup" }));
    } finally {
      off();
    }
  });

  it("re-registration after release works, and release is idempotent", () => {
    const off = useProgramRegistry.getState().register("p1", prog("re"));
    off();
    off(); // idempotent
    const off2 = useProgramRegistry.getState().register("p1", prog("re"));
    off2();
  });
});

describe("autorunCommandOf — run the command verbatim, with no wrapping", () => {
  it("a view program with no command (a bare terminal) is undefined", () => {
    expect(autorunCommandOf(prog("t"))).toBeUndefined();
  });

  it("returns the command verbatim for an agent program — a terminal view plus autorun", () => {
    expect(autorunCommandOf(prog("c", { command: "claude" }))).toBe("claude");
  });

  it("ensure does not change the run command — installation is enable-time work", () => {
    expect(
      autorunCommandOf(
        prog("c", {
          command: "claude",
          ensure: { bin: "claude", install: { darwin: "curl …" } },
        }),
      ),
    ).toBe("claude");
  });
});

describe("installCommandFor — the enable-time install command, per platform", () => {
  const decl = prog("c", {
    command: "claude",
    ensure: {
      bin: "claude",
      install: {
        darwin: "curl -fsSL https://claude.ai/install.sh | bash",
        win32: "irm https://claude.ai/install.ps1 | iex",
      },
    },
  });

  it("returns this platform official install command verbatim", () => {
    expect(installCommandFor(decl, "darwin")).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(installCommandFor(decl, "win32")).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    );
  });

  it("an unlisted platform or a missing ensure is undefined", () => {
    expect(installCommandFor(decl, "linux")).toBeUndefined();
    expect(installCommandFor(prog("t"), "darwin")).toBeUndefined();
  });
});
