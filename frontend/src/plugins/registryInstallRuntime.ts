import { moduleState } from "../lib/moduleState";
import type {
  CertifiedRegistry,
  RegistryPlugin,
  ReleaseDocument,
} from "./spec";
import type { PluginInstallProgress } from "./registryInstallProgress";

export interface RegistryInstallRuntimeInput {
  certified: CertifiedRegistry;
  root: RegistryPlugin;
  releases: ReleaseDocument[];
  onProgress?: (progress: Pick<PluginInstallProgress, "phase" | "completed" | "total" | "componentId">) => void;
}

export type RegistryInstallRuntimeResult =
  | { ok: true; id: string; version: string; revision: number }
  | { ok: false; code: string; message: string; errors?: string[] };

export type RegistryInstallRuntimeHandler = (
  input: RegistryInstallRuntimeInput,
) => Promise<RegistryInstallRuntimeResult>;

const unavailable: RegistryInstallRuntimeHandler = async () => ({
  ok: false,
  code: "INSTALL_RUNTIME_UNAVAILABLE",
  message: "the native atomic release installer is not available in this build",
});

// The injection point must survive the module swap boundary — if only this slot is cleared, the
// side that already set it does not set it again; nothing responds, and that silence is not an error.
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

export function installCertifiedRegistryRelease(
  input: RegistryInstallRuntimeInput,
): Promise<RegistryInstallRuntimeResult> {
  return handlerSlot.v(input);
}
