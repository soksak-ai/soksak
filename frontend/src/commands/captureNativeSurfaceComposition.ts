import type { AppliedSurface } from "../lib/contentViews";

export interface SurfacePicturePlacement {
  id: string;
  alpha: number;
  source: { x: number; y: number; w: number; h: number };
  target: { x: number; y: number; w: number; h: number };
}

export interface DocumentCapture {
  png: string;
  note: Record<string, unknown> & { documentOnly?: boolean };
}

export interface ComposedCapture extends DocumentCapture {
  note: Record<string, unknown> & {
    documentOnly: false;
    nativeComposed: boolean;
    surfaces: number;
    drawn: number;
  };
}

/** Native dim is a black veil above opaque content, matching the document lighting plane. */
export function nativeSurfacePicturePaint(alpha: number): { pictureAlpha: 1; veilAlpha: number } {
  const retained = Math.max(0, Math.min(1, alpha));
  return { pictureAlpha: 1, veilAlpha: 1 - retained };
}

export function nativeSurfacePicturePlacements(
  region: { x: number; y: number; w: number; h: number },
  surfaces: readonly AppliedSurface[],
): SurfacePicturePlacement[] {
  const right = region.x + region.w;
  const bottom = region.y + region.h;
  return surfaces
    .map((surface, index) => ({ surface, index }))
    .filter(({ surface }) => surface.visible && surface.w > 0 && surface.h > 0)
    .sort((left, rightSurface) =>
      (left.surface.layer ?? 0) - (rightSurface.surface.layer ?? 0) || left.index - rightSurface.index)
    .flatMap(({ surface }) => {
      const x = Math.max(region.x, surface.x);
      const y = Math.max(region.y, surface.y);
      const clippedRight = Math.min(right, surface.x + surface.w);
      const clippedBottom = Math.min(bottom, surface.y + surface.h);
      if (clippedRight <= x || clippedBottom <= y) return [];
      const w = clippedRight - x;
      const h = clippedBottom - y;
      return [{
        id: surface.id,
        alpha: Math.max(0, Math.min(1, surface.alpha ?? 1)),
        source: { x: x - surface.x, y: y - surface.y, w, h },
        target: { x: x - region.x, y: y - region.y, w, h },
      }];
    });
}

const loadImage = async (source: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.src = source;
  await image.decode();
  return image;
};

export async function composeNativeSurfacePictures(
  capture: DocumentCapture,
  region: { x: number; y: number; w: number; h: number },
  surfaces: readonly AppliedSurface[],
  picture: (id: string) => Promise<string | null>,
  background: string,
): Promise<DocumentCapture | ComposedCapture> {
  if (capture.note.documentOnly !== true) return capture;
  const placements = nativeSurfacePicturePlacements(region, surfaces);
  if (!background) throw new Error("CAPTURE_BACKGROUND_UNAVAILABLE: theme --bg is empty");
  const base = await loadImage(`data:image/png;base64,${capture.png}`);
  const pictures = await Promise.all(placements.map(async (placement) => {
    const source = await picture(placement.id);
    if (!source) throw new Error(`VISIBLE_SURFACE_CAPTURE_FAILED: ${placement.id} returned no PNG`);
    return loadImage(source);
  }));
  const canvas = document.createElement("canvas");
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("VISIBLE_SURFACE_CAPTURE_FAILED: 2d composition is unavailable");
  context.globalAlpha = 1;
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(base, 0, 0);
  const scaleX = canvas.width / region.w;
  const scaleY = canvas.height / region.h;
  const surfaceById = new Map(surfaces.map((surface) => [surface.id, surface]));
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    const image = pictures[index];
    if (!placement || !image) continue;
    const surface = surfaceById.get(placement.id);
    if (!surface) throw new Error(`VISIBLE_SURFACE_CAPTURE_FAILED: ${placement.id} left the applied inventory`);
    const paint = nativeSurfacePicturePaint(placement.alpha);
    context.globalAlpha = paint.pictureAlpha;
    context.drawImage(
      image,
      placement.source.x / surface.w * image.naturalWidth,
      placement.source.y / surface.h * image.naturalHeight,
      placement.source.w / surface.w * image.naturalWidth,
      placement.source.h / surface.h * image.naturalHeight,
      placement.target.x * scaleX,
      placement.target.y * scaleY,
      placement.target.w * scaleX,
      placement.target.h * scaleY,
    );
    if (paint.veilAlpha > 0) {
      context.globalAlpha = paint.veilAlpha;
      context.fillStyle = "black";
      context.fillRect(
        placement.target.x * scaleX,
        placement.target.y * scaleY,
        placement.target.w * scaleX,
        placement.target.h * scaleY,
      );
    }
  }
  context.globalAlpha = 1;
  const encoded = canvas.toDataURL("image/png");
  const prefix = "data:image/png;base64,";
  if (!encoded.startsWith(prefix)) throw new Error("VISIBLE_SURFACE_CAPTURE_FAILED: canvas returned no PNG");
  return {
    png: encoded.slice(prefix.length),
    note: {
      ...capture.note,
      documentOnly: false,
      nativeComposed: true,
      surfaces: placements.length,
      drawn: placements.length,
    },
  };
}
