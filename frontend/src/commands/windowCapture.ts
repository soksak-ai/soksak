import { invoke } from "../framework";
import { contentViewHost } from "../lib/contentViews";
import { captureAfterPresentation } from "./capturePresentation";
import {
  composeNativeSurfacePictures,
  type DocumentCapture,
} from "./captureNativeSurfaceComposition";
import { nativeDecorationFacts } from "../lib/nativeDecorations";

export async function captureWindowPixels(
  rect?: { x: number; y: number; w: number; h: number },
): Promise<DocumentCapture> {
  return captureAfterPresentation(
    window,
    () => invoke<{ ordered: boolean }>("window_capture_present", {}),
    async () => {
      const shot = await invoke<DocumentCapture>(
        "window_snapshot_region",
        rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
      );
      const region = rect ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
      const host = contentViewHost();
      const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      return composeNativeSurfacePictures(
        shot,
        region,
        await host.appliedSurfaces(),
        (id) => host.picture(id),
        background,
        nativeDecorationFacts().decorations,
      );
    },
    (presentation) => invoke("window_capture_restore", { ordered: presentation.ordered }).then(() => undefined),
  );
}
