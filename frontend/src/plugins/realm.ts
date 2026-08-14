/**
 * Realm identity declaration — which realm this app runs in, and what can be called there.
 *
 * Why it exists: the same plugin bundle is evaluated in two realms. One is the window document, the
 * other is the child renderer of a nativeSurface view. The app surfaces of the two realms are not
 * equal — the child does not own the per-window registries (command, view) and only consumes
 * execution. That difference was written down nowhere, so plugins probed for it with expressions like
 * `typeof app.commands?.register === "function"`. Three browser plugins probed the same absence three
 * different ways; two passed and one died on the spot
 * (measured 2026-08-07: browser-chromium-offscreen, "app.commands.register is not a function").
 *
 * Probing is not the answer. The realm answers its own identity and capabilities by declaration.
 *
 * The declaration is not written by hand. A list enumerated at the consumer always misses one, and
 * the missing one becomes a silent lie. The capability list is derived from the real app object, so
 * it cannot diverge from that object.
 */

export type PluginRealmId =
  /** app evaluated in the window document. Owner of the per-window registries. */
  | "window"
  /** app evaluated in the child renderer of a nativeSurface view. Delegates to the parent over RPC. */
  | "view-renderer";

export interface PluginRealm {
  readonly id: PluginRealmId;
  /** Every name callable in this realm (dot notation, sorted). Derived from the app object. */
  readonly capabilities: readonly string[];
  /**
   * Query the exact name you will call. A namespace being present does not mean everything inside it
   * is — `supports("commands")` is false and `supports("commands.execute")` is the answer.
   */
  supports(capability: string): boolean;
}

/** realm is the answer, not a capability — it is not counted in its own list. */
const REALM_KEY = "realm";
/** data.kv.get is the deepest. Anything nested deeper is a value, not an app surface. */
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns every callable name the app object actually holds.
 *
 * Accessors are neither counted nor read — if counting produces a side effect, the measurement is not observation.
 */
export function pluginRealmCapabilities(app: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH || !isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (!prefix && key === REALM_KEY) continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof descriptor.value === "function") found.add(path);
      else walk(descriptor.value, path, depth + 1);
    }
  };
  walk(app, "", 1);
  return [...found].sort();
}

/**
 * Attaches the realm of this app as a declaration. One app has one realm — a second declaration is refused.
 */
export function declarePluginRealm<T extends object>(
  id: PluginRealmId,
  app: T,
): T & { realm: PluginRealm } {
  const capabilities: readonly string[] = Object.freeze(pluginRealmCapabilities(app));
  const declared = new Set(capabilities);
  const realm: PluginRealm = Object.freeze({
    id,
    capabilities,
    supports: (capability: string) => declared.has(capability),
  });
  Object.defineProperty(app, REALM_KEY, {
    value: realm,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return app as T & { realm: PluginRealm };
}
