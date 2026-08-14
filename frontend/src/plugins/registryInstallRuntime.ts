import { moduleState } from "../lib/moduleState";
import type {
  CertifiedRegistryIndex,
  RegistryUnitIdentity,
} from "./spec";

export interface RegistryInstallRuntimeInput {
  certified: CertifiedRegistryIndex;
  root: RegistryUnitIdentity;
}

export type RegistryInstallRuntimeResult =
  | { ok: true; id: string; version: string; generation: string }
  | { ok: false; code: string; message: string; errors?: string[] };

export type RegistryInstallRuntimeHandler = (
  input: RegistryInstallRuntimeInput,
) => Promise<RegistryInstallRuntimeResult>;

const unavailable: RegistryInstallRuntimeHandler = async () => ({
  ok: false,
  code: "INSTALL_RUNTIME_UNAVAILABLE",
  message: "the native atomic release installer is not available in this build",
});

// The injection point must cross the hot-swap boundary — when only this slot is empty, the side
// that filled it treats it as already filled and does not refill. What remains is "nobody
// answers", and that silence is not an error.
const handlerSlot = moduleState("plugins/registryInstallRuntime#handlerSlot.v", () => ({ v: unavailable }));
export function setRegistryInstallRuntime(
  next: RegistryInstallRuntimeHandler,
): () => void {
  const current = handlerSlot.v;
  handlerSlot.v = next;
  return () => {
    handlerSlot.v = current;
  };
}

export function installCertifiedRegistryUnit(
  input: RegistryInstallRuntimeInput,
): Promise<RegistryInstallRuntimeResult> {
  return handlerSlot.v(input);
}
