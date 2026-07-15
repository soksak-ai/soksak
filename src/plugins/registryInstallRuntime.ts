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

let handler = unavailable;

export function setRegistryInstallRuntime(
  next: RegistryInstallRuntimeHandler,
): () => void {
  const current = handler;
  handler = next;
  return () => {
    handler = current;
  };
}

export function installCertifiedRegistryUnit(
  input: RegistryInstallRuntimeInput,
): Promise<RegistryInstallRuntimeResult> {
  return handler(input);
}
