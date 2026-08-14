import { startNativeSurfaces } from "../framework/wails";
import { applyTheme, DEFAULT_THEME } from "../theme/tokens";

import { registerPlugins } from "./plugins";

/**
 * Bring the application up.
 *
 * Boot waits for this. Rendering before the registries are filled would leave
 * the first frame deciding what exists, and that decision would depend on
 * module evaluation order.
 */
export function boot(): { stop: () => void } {
  // Paint before the first render. A frame drawn before the tokens exist shows
  // the browser's defaults, and that flash is the theme arriving late.
  applyTheme(DEFAULT_THEME);
  registerPlugins();
  const stopNativeSurfaces = startNativeSurfaces();
  return { stop: stopNativeSurfaces };
}
