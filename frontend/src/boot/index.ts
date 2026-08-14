import { startNativeSurfaces } from "../framework/wails";

import { registerPlugins } from "./plugins";

/**
 * Bring the application up.
 *
 * Boot waits for this. Rendering before the registries are filled would leave
 * the first frame deciding what exists, and that decision would depend on
 * module evaluation order.
 */
export function boot(): { stop: () => void } {
  registerPlugins();
  const stopNativeSurfaces = startNativeSurfaces();
  return { stop: stopNativeSurfaces };
}
