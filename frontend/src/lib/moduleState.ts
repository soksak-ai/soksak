// Definition site for module-global state — what is declared here survives a hot swap.
//
// The dev server hot-swaps an edited module and its importer chain. A registry held in module
// scope becomes a new empty one at that point, and if the module that filled it is not
// re-evaluated with it, it **stays empty forever**. Registration is a side effect of module
// evaluation: if the filling side does not run, it is never refilled.
//
// Measured (2026-07-31): the core command catalog disappeared entirely. The window was alive and
// plugin commands answered, but `ui.*`, `state.*` and `window.*` were all UNKNOWN_COMMAND. To the
// user it looked like "the + on the tab does not create anything" (+ disappears when registered
// programs is 0), and the cause was written nowhere on screen. Working things stop working, as if
// by chance.
//
// Storage is globalThis, the only place a hot swap does not touch — putting it in this module's
// own `import.meta.hot.data` reproduces the same defect the moment this file is edited.
//
// Production bundles have no hot swap. There it is simply created (zero global pollution).

const BAG_KEY = "__soksakModuleState";

function bag(): Map<string, { value: unknown; make: unknown }> | null {
  // env is bundler-injected — absent or PROD means an environment that needs no preservation.
  const env = (import.meta as { env?: { PROD?: boolean } }).env;
  if (!env || env.PROD) return null;
  const g = globalThis as Record<string, unknown>;
  const existing = g[BAG_KEY];
  if (existing instanceof Map) return existing as Map<string, { value: unknown; make: unknown }>;
  const fresh = new Map<string, { value: unknown; make: unknown }>();
  g[BAG_KEY] = fresh;
  return fresh;
}

/**
 * Returns the same value across a hot swap.
 *
 * `key` is the name of that state — build it uniquely from the module path plus the variable name.
 * If two states use the same name, one inherits the other's content (silent pollution). A
 * **static gate** catches that collision: a hot swap changes function identity, so at runtime
 * there is no way to separate "re-evaluation of the same site" from "another site taking the
 * name".
 */
export function moduleState<T>(key: string, make: () => T): T {
  const b = bag();
  if (!b) return make();
  const hit = b.get(key) as { value: T; make: unknown } | undefined;
  if (hit) {
    // On re-evaluation of the same site make is a new function but **the name is the same** —
    // that is normal. When another site uses the same name it silently receives someone else's
    // value: measured (2026-07-31) — two states in one file both used `#state`, so the later one
    // received the earlier one's object and had none of its own fields. Silent pollution raises no
    // error. So the split is made **by shape**.
    const want = make();
    if (!sameShape(hit.value, want)) {
      throw new Error(
        `module state name collision: ${key} — two states of different shape use one name`,
      );
    }
    return hit.value;
  }
  const value = make();
  b.set(key, { value, make });
  return value;
}

/**
 * Same site or not — plain objects compare by key set, everything else (Map, Set, classes) by
 * constructor **name**.
 *
 * Do not split on constructor identity. Module re-evaluation creates a new constructor object even
 * for the same class, so identity differs and a normal re-evaluation reads as a name collision —
 * a reload becomes a crash (measured: refilling the command registry threw that
 * `components/PluginViewHost#overlayLedger` had a different shape). The name is unchanged across
 * re-evaluation and still differs between different classes.
 */
function sameShape(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return typeof a === typeof b;
  if (typeof a !== "object" || typeof b !== "object") return typeof a === typeof b;
  const ca = a.constructor;
  const cb = (b as object).constructor;
  if (ca?.name !== cb?.name) return false;
  if (ca !== Object) return true; // for Map, Set, and classes the constructor name is enough
  const ka = Object.keys(a).sort().join(",");
  const kb = Object.keys(b as object).sort().join(",");
  return ka === kb;
}
