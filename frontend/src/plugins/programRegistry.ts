// Program registry — the single store for new-tab (+) menu entries (§2.6).
// Programs are fully declarative (manifest contributes.programs), so the loader
// registers them automatically on activation — there is no imperative registration
// API (declaration = single source of truth; the consent screen states the whole
// behavior as the literal command). The menu (ProgramMenu), settings (default
// program), and commands (view.open program=) all consume this (§0-1).

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import type { ContributedProgram, LibraryDep } from "./spec";
import { tmsg } from "../i18n";

export interface RegisteredProgram {
  pluginId: string;
  decl: ContributedProgram; // manifest declaration = the single truth for display and behavior
}

interface ProgramRegistryState {
  programs: Record<string, RegisteredProgram>; // key = global program id (flat)
  order: string[]; // registration order (menu display order)
  version: number; // increments on every register/unregister — rebuild signal for the UI
  register: (pluginId: string, decl: ContributedProgram) => () => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useProgramRegistry = moduleState("plugins/programRegistry#store", () =>
  create<ProgramRegistryState>((set, get) => ({
  programs: {},
  order: [],
  version: 0,

  register: (pluginId, decl) => {
    const id = decl.id;
    if (get().programs[id]) {
      // §0-3 no silent failure — a global id collision is an error at registration time.
      throw new Error(tmsg("plugin.program.duplicateId", { id }));
    }
    set((s) => ({
      programs: { ...s.programs, [id]: { pluginId, decl } },
      order: [...s.order, id],
      version: s.version + 1,
    }));
    return () => {
      set((s) => {
        if (!s.programs[id]) return s; // already unregistered — idempotent
        const programs = { ...s.programs };
        delete programs[id];
        return {
          programs,
          order: s.order.filter((x) => x !== id),
          version: s.version + 1,
        };
      });
    };
  },
})),
);

export function getRegisteredProgram(id: string): RegisteredProgram | null {
  return useProgramRegistry.getState().programs[id] ?? null;
}

// List for menu and settings display (registration order preserved).
export function listPrograms(): RegisteredProgram[] {
  const s = useProgramRegistry.getState();
  return s.order.map((id) => s.programs[id]).filter(Boolean);
}

export type PlatformKey = "darwin" | "linux" | "win32";

// Detect the running platform (to branch install commands). Where platform is empty (tests), fall
// back to the UA string.
export function detectPlatform(): PlatformKey {
  const s = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (s.includes("mac")) return "darwin";
  if (s.includes("win")) return "win32";
  return "linux";
}

// A program's autorun command — run verbatim, no wrapping.
// Every program is kind:"view" (the core terminal is removed) — the command is passed
// to the view that opens (the terminal view) and runs once on mount. ensure (install
// when missing) is handled at **plugin activation time**, not at run time
// (state/plugins.ensureProgramBinaries) — the moment the consent screen stated the
// install command and the user chose "consent and activate" is the legitimate place
// to install.
export function autorunCommandOf(
  decl: ContributedProgram,
): string | undefined {
  return decl.command;
}

// Install command for this platform (ensure declaration) — consumed by the activation-time install
// flow.
export function installCommandFor(
  decl: ContributedProgram,
  platform: PlatformKey = detectPlatform(),
): string | undefined {
  return decl.ensure?.install[platform];
}

// Library install command for this platform (libraries declaration) — consumed by the forced
// install flow after consent. The consent screen states this command verbatim, and the moment a
// person consented is the legitimate place to install.
export function libraryInstallFor(
  lib: LibraryDep,
  platform: PlatformKey = detectPlatform(),
): string | undefined {
  return lib.install[platform];
}
