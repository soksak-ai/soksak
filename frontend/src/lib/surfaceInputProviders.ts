// Owner of a surface's input — whoever created the surface delivers that surface's pointer events.
//
// Pointer input arrived only at the surfaces the core held (framework child webviews). A surface a
// plugin draws through an engine sidecar was not covered by the core's path and was rejected as
// "no webview" — measured 2026-08-08: of three browsers only one took gestures, and the other two
// got rejections that differed only in name.
//
// The core must not identify the engine. The plugin that created the surface identifies it, and
// the core's only job is to provide **the place to ask who the owner is**. With an owner, input
// goes there; without one, to the framework.
import { moduleState } from "./moduleState";
import type { SurfacePointerInput } from "./contentViews";

/** The side that injects pointer input into one surface and answers its state — the contract has the same shape as the framework adapter. */
export interface SurfaceInputProvider {
  /**
   * Is this label mine.
   *
   * The core never guesses from label syntax — splitting by prefix delivers to someone else's surface
   * the day that syntax changes. The owner answers for itself.
   */
  owns(label: string): boolean;
  sendInput(label: string, input: SurfacePointerInput): Promise<void>;
  inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
}

/** The registry is outside the hot-swap boundary — a registered owner must survive a new module instance. */
const state = moduleState("lib/surfaceInputProviders#registry", () => ({
  byOwner: new Map<string, SurfaceInputProvider>(),
}));

/**
 * Registers that this plugin delivers input for its own surfaces. Returns the unregister function —
 * when the view is gone the owner goes with it (left behind, delivery keeps going to a dead sidecar).
 *
 * Registering the same owner again replaces it. Two copies would make the duplicate check below
 * collide with itself.
 */
export function registerSurfaceInputProvider(
  owner: string,
  provider: SurfaceInputProvider,
): () => void {
  state.byOwner.set(owner, provider);
  return () => {
    if (state.byOwner.get(owner) === provider) state.byOwner.delete(owner);
  };
}

/**
 * Owner of this surface. `null` when there is none — the framework takes that place.
 *
 * Throws when two claim it. Picking one would leave no value that shows where delivery goes, and that
 * ambiguity stays silent for a long time.
 */
export function surfaceInputProvider(label: string): SurfaceInputProvider | null {
  const claimed: string[] = [];
  let found: SurfaceInputProvider | null = null;
  for (const [owner, provider] of state.byOwner) {
    let owns: boolean;
    try {
      owns = provider.owns(label);
    } catch (error) {
      // Swallowing a failed verdict leaks delivery to the framework silently.
      throw new Error(
        tmsg("msg.ui.input.surfaceOwnerCheckFailed", {
          owner,
          label,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (!owns) continue;
    claimed.push(owner);
    found = provider;
  }
  if (claimed.length > 1) {
    throw new Error(tmsg("msg.ui.input.surfaceOwnerConflict", { label, owners: claimed.join(", ") }));
  }
  return found;
}

/** Currently registered owners — an observation surface (with no count of who took what, "nobody took it" is invisible). */
export function surfaceInputOwners(): string[] {
  return [...state.byOwner.keys()].sort();
}

/** Test-only reset — the registry is outside the hot-swap boundary, so module re-evaluation does not clear it. */
export function __resetSurfaceInputProvidersForTest(): void {
  state.byOwner.clear();
}
