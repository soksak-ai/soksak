import { railStationFromLeftPx } from "./railPlacement";

export interface RailWidthResizePlan {
  widthPx: number;
  station: number;
  leftPx: number;
  rightPx: number;
  moves: { axis: "x"; line: number; px: number }[];
}

export function railWidthResizePlan({
  gutters,
  startStation,
  hostWidthPx,
  startWidthPx,
  requestedWidthPx,
}: {
  gutters: readonly { splitId: string; dir: "row" | "col"; index: number; rect: { left: number } }[];
  startStation: number;
  hostWidthPx: number;
  startWidthPx: number;
  requestedWidthPx: number;
}): RailWidthResizePlan | null {
  if (![startStation, hostWidthPx, startWidthPx, requestedWidthPx].every(Number.isFinite) || hostWidthPx <= 0 || startStation <= 0 || startStation >= 100) return null;
  const anchor = gutters.filter((gutter) => gutter.dir === "row").reduce<(typeof gutters)[number] | null>((best, gutter) => best === null || Math.abs(gutter.rect.left - startStation) < Math.abs(best.rect.left - startStation) ? gutter : best, null);
  if (!anchor || Math.abs(anchor.rect.left - startStation) > 0.75) return null;
  const leftPx = ((hostWidthPx - startWidthPx) * startStation) / 100;
  const station = railStationFromLeftPx(leftPx, hostWidthPx, requestedWidthPx);
  const widthPx = requestedWidthPx;
  return { widthPx, station, leftPx, rightPx: leftPx + widthPx, moves: [{ axis: "x", line: anchor.index, px: station }] };
}
