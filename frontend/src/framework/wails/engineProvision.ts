import type { EngineProvision } from "../../plugins/spec";
import { detectPlatform, type PlatformKey } from "../../lib/runtimePlatform";

export function wailsEngineProvision(
  platform: PlatformKey = detectPlatform(),
): EngineProvision {
  return {
    chromium: false,
    nativeChildWebview: platform === "darwin",
    engineModules: false,
    supportsDocumentStart: false,
    supportsInputInjection: false,
  };
}
