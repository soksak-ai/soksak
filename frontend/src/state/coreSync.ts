// createCoreSync — thin glue that connects a zustand persistent store (settings/theme/plugins/…) to coreStore.
//
// [RULE] The authority for core persistent state is app.data (multi-window broadcast). localStorage
// is only a synchronous boot cache (for the synchronous load before render). Each store provides just
// the serialized state T, and this glue does the rest:
//  - loadSync(): fills from the ls cache at module init (fallback when absent).
//  - save(T): ls only before boot, ls + app.data (coreStore.save) after init(deps).
//  - init(deps): hydrate the app.data authority value -> apply, subscribe to other-window changes ->
//    apply. On first run coreStore migrates the ls cache into app.data once (no downtime). Returns
//    the unsubscribe function.

import { makeCoreStore, type CoreStore, type CoreStoreDeps } from "./coreStore";

export interface CoreSync<T> {
  loadSync: () => T;
  save: (value: T) => void;
  /** Persist before returning. Security continuity state uses this boundary. */
  saveNow: (value: T) => Promise<void>;
  init: (deps: CoreStoreDeps) => () => void;
  /** Flush the pending debounced authority write immediately (pagehide, unsubscribe, tests). */
  flush: () => void;
}

// Debounce for the authority persist (app.data: SQLite write + broadcast to all windows) — folds a
// burst such as ⌘± autorepeat or a slider drag into one settled write instead of a disk/IPC/broadcast
// storm per key. The live UI (in-memory set) and the sync cache (localStorage) stay immediate, so
// responsiveness and crash-safe boot are kept. Trailing edge (one write after this much quiet).
const PERSIST_DEBOUNCE_MS = 300;

export function createCoreSync<T>(opts: {
  /** kv key inside the core ns. */
  key: string;
  /** localStorage key for the synchronous boot cache (the existing key is kept, no downtime). */
  lsKey: string;
  fallback: T;
  /** Applies the authority value (app.data hydrate / other-window broadcast) to the store. */
  apply: (value: T) => void;
}): CoreSync<T> {
  const { key, lsKey, fallback, apply } = opts;
  let store: CoreStore<T> | null = null;
  // Authority write value waiting on the debounce (trailing — only the latest is kept). null = nothing pending.
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const writeCache = (value: T) => {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(value));
    } catch {
      /* A cache write failure is not fatal — the authority is app.data */
    }
  };

  const loadSync = (): T => {
    try {
      const raw = window.localStorage.getItem(lsKey);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };

  // Flush the pending authority write now (debounce expiry, flush, unsubscribe). store.save = ls (redundant, harmless) + app.data authority.
  const flush = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending && store) {
      const v = pending.value;
      pending = null;
      void store.save(v);
    }
  };

  const save = (value: T): void => {
    writeCache(value); // Immediate — synchronous cache (crash-safe at boot). localStorage costs no IPC.
    if (!store) return; // Before boot — cache only (no app.data access).
    // Set the in-memory authority right away (read-your-writes): the disk (SQLite) flush is debounced
    // below, but a later authority read in this window (hydrate/subscribe) must see the value just
    // written (an older value on disk must not overwrite it as stale).
    store.stage(value);
    // Only the authority disk flush (SQLite + broadcast to all windows) is debounced — a burst folds into one settled write.
    pending = { value };
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  };

  const saveNow = async (value: T): Promise<void> => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    writeCache(value);
    if (store) await store.save(value);
  };

  const init = (deps: CoreStoreDeps): (() => void) => {
    store = makeCoreStore<T>({ key, lsKey, fallback, ...deps });
    void store.hydrate().then(apply);
    const unsub = store.subscribe(apply);
    // Flush the pending write just before the window closes — prevents losing the last change on exit inside the debounce window (≤300ms), reinforcing crash safety.
    const onHide = () => flush();
    if (typeof window !== "undefined") window.addEventListener("pagehide", onHide);
    return () => {
      flush(); // Write out what is left when the subscription ends
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onHide);
      unsub();
    };
  };

  return { loadSync, save, saveNow, init, flush };
}
