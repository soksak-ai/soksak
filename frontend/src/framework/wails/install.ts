import { registerContentViewHost } from "../../lib/contentViews";
import { registerLayoutTransitionHost } from "../../lib/layoutTransitionHost";

import { wailsContentViewHost } from "./contentViews";
import { startNativeSurfaces } from "./nativeSurfaces";
import { wailsLayoutTransitionHost } from "./layoutTransitionHost";

/**
 * What the selected adapter registers on core surfaces — implementations, devices, styles.
 *
 * Boot awaits this. Without the await it becomes a timing assumption that "nobody calls in between",
 * and that assumption is wrong sooner or later.
 */
export async function installWailsSurfaces(): Promise<void> {
  // The content view implementation goes first. Core commits every tab's visibility through this
  // implementation (lib/viewPark.commitViewPresentation), so without it the first view open throws
  // inside render and the whole window goes blank — measured 2026-08-15, exposed nodes 64 → 0.
  registerContentViewHost(wailsContentViewHost);
  registerLayoutTransitionHost(wailsLayoutTransitionHost);
  startNativeSurfaces();
}
