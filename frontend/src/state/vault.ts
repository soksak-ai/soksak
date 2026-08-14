// Volatile state of the recovery-code UI flow — setup/enter modal routing plus the one-time recovery
// code. The recovery code never lands on disk (persist forbidden) — the value returned once by
// enable/rotate/changeRecovery stays in memory only while the setup modal displays it.
// Modal open/close is expressed as a nullable field (closeConfirm pattern) — no separate boolean, no
// conditional mount.
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

export type RecoveryOrigin = "setup" | "rotate" | "changeRecovery";

export interface PendingRecovery {
  code: string;
  origin: RecoveryOrigin;
}

interface VaultUiState {
  openModal: "setup" | "enter" | null; // null = closed (the gate)
  pendingCode: PendingRecovery | null; // recovery code the setup modal shows once
  targetScope: string; // scope the enter modal unlocks
  showSetup: (code: string, origin: RecoveryOrigin) => void;
  showEnter: (scope: string) => void;
  close: () => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useVault = moduleState("state/vault#store", () =>
  create<VaultUiState>((set) => ({
  openModal: null,
  pendingCode: null,
  targetScope: "",
  showSetup: (code, origin) => set({ openModal: "setup", pendingCode: { code, origin } }),
  showEnter: (scope) => set({ openModal: "enter", targetScope: scope }),
  // Closing also clears the volatile recovery code at once (zero residue outside memory).
  close: () => set({ openModal: null, pendingCode: null }),
})),
);
