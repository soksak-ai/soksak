import type { NativeDecoration, NativeDecorationReceipt } from "../framework";
import { commitNativeDecorations } from "../framework";
import { moduleState } from "./moduleState";

type RGBA = { r: number; g: number; b: number; a: number };

const state = moduleState("lib/nativeDecorations#registry", () => ({
  byOwner: new Map<string, readonly NativeDecoration[]>(),
  scheduled: false,
  running: false,
  dirty: false,
  lastSignature: "",
  lastReceipt: null as NativeDecorationReceipt | null,
  error: null as string | null,
}));

function snapshot(): NativeDecoration[] {
  return [...state.byOwner.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, decorations]) => [...decorations])
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function flush(): Promise<NativeDecorationReceipt | null> {
  state.scheduled = false;
  if (state.running || !state.dirty) return state.lastReceipt;
  state.running = true;
  state.dirty = false;
  const decorations = snapshot();
  const signature = JSON.stringify(decorations);
  if (signature === state.lastSignature) {
    state.running = false;
    if (state.dirty) schedule();
    return state.lastReceipt;
  }
  try {
    const receipt = await commitNativeDecorations(decorations);
    // A newer snapshot may have been scheduled while this one crossed the bridge. Its own commit
    // remains queued; this receipt is still the truthful last answer until then.
    state.lastSignature = signature;
    state.lastReceipt = receipt;
    state.error = null;
    document.documentElement.dataset.nativeDecorationSequence = String(receipt.sequence);
    document.documentElement.dataset.nativeDecorationCount = String(receipt.count);
    document.documentElement.dataset.nativeDecorationLayer = receipt.layer;
    delete document.documentElement.dataset.nativeDecorationError;
    return receipt;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.nativeDecorationError = state.error;
    throw error;
  } finally {
    state.running = false;
    // A commit made while this one crossed the bridge owns the next full snapshot. Serial delivery
    // prevents an older receipt from arriving after a newer one and restoring stale geometry.
    if (state.dirty) schedule();
  }
}

function schedule(): void {
  state.dirty = true;
  if (state.scheduled || state.running) return;
  state.scheduled = true;
  // One microtask coalesces every child layout effect in the same React commit. This is an event
  // edge, not a clock: there is no polling interval, retry loop or second animation timeline.
  queueMicrotask(() => { void flush().catch((error) => {
    console.error("native decoration commit failed", error);
  }); });
}

/** Replaces one component owner's complete contribution. Empty removes that owner. */
export function replaceNativeDecorations(
  owner: string,
  decorations: readonly NativeDecoration[],
): void {
  if (decorations.length === 0) state.byOwner.delete(owner);
  else state.byOwner.set(owner, [...decorations]);
  schedule();
}

export function nativeDecorationFacts(): {
  decorations: NativeDecoration[];
  receipt: NativeDecorationReceipt | null;
  error: string | null;
} {
  return { decorations: snapshot(), receipt: state.lastReceipt, error: state.error };
}

/** Test reset also commits the empty ownership map on the next event edge. */
export function __resetNativeDecorationsForTest(): void {
  state.byOwner.clear();
  state.scheduled = false;
  state.running = false;
  state.dirty = false;
  state.lastSignature = "";
  state.lastReceipt = null;
  state.error = null;
}

/** Resolves a CSS color to numeric sRGB for the native layer. */
export function cssColorRGBA(value: string): RGBA | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const raw = hex[1].length === 3
      ? [...hex[1]].map((part) => part + part).join("")
      : hex[1];
    const number = Number.parseInt(raw.slice(0, 6), 16);
    return {
      r: ((number >> 16) & 255) / 255,
      g: ((number >> 8) & 255) / 255,
      b: (number & 255) / 255,
      a: raw.length === 8 ? Number.parseInt(raw.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (rgb) {
    const alpha = rgb[4]
      ? (rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]))
      : 1;
    return {
      r: Number.parseFloat(rgb[1]) / 255,
      g: Number.parseFloat(rgb[2]) / 255,
      b: Number.parseFloat(rgb[3]) / 255,
      a: alpha,
    };
  }
  // Browser fallback covers named, hsl(), lab() and color() values accepted by the theme engine.
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  } catch {
    return null;
  }
}

export function strokeDecoration(
  id: string,
  path: string,
  color: RGBA,
  strokeWidth: number,
  dash: number[] = [],
): NativeDecoration {
  return {
    id, path,
    strokeR: color.r, strokeG: color.g, strokeB: color.b, strokeA: color.a,
    strokeWidth, dash,
  };
}
