import { startNativeSurfaces } from "./nativeSurfaces";

/**
 * What the selected adapter registers on core surfaces — implementations, devices, styles.
 *
 * Boot awaits this. Without the await it becomes a timing assumption that "nobody calls in between",
 * and that assumption is wrong sooner or later.
 */
export async function installWailsSurfaces(): Promise<void> {
  startNativeSurfaces();
}
