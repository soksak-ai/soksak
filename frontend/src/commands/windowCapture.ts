import { invoke } from "../framework";
import { contentViewHost } from "../lib/contentViews";
import { captureAfterPresentation } from "./capturePresentation";
import {
  composeNativeSurfacePictures,
  type DocumentCapture,
} from "./captureNativeSurfaceComposition";

export async function captureWindowPixels(
  rect?: { x: number; y: number; w: number; h: number },
): Promise<DocumentCapture> {
  return captureAfterPresentation(
    window,
    () => invoke<{ ordered: boolean }>("window_capture_present", {}),
    async (presentation) => {
      const shot = await invoke<DocumentCapture>(
        "window_snapshot_region",
        rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
      );
      const region = rect ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
      const host = contentViewHost();
      const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      const capture = await composeNativeSurfacePictures(
        shot,
        region,
        await host.appliedSurfaces(),
        (id) => host.picture(id),
        background,
      );
      return {
        ...capture,
        note: { ...capture.note, presentationOrdered: presentation.ordered },
      };
    },
    (presentation) => invoke("window_capture_restore", { ordered: presentation.ordered }).then(() => undefined),
  );
}
