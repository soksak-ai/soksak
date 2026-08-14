// core kv storage helper — the single storage abstraction for core persistent state
// (settings, layout, window-manifest).
//
// [RULE] Two layers combined:
//  - localStorage (synchronous boot cache): kept because a synchronous load before render is
//    required (zustand load()). Demoted to "offline first-level cache" — not the authority.
//  - app.data core ns (authority + cross-window broadcast): data_kv_set emits data-change to every
//    window → another window applies the same key change with 0 polling (localStorage has no such
//    channel — which is why this layer exists).
//
// write = both (sync cache + authority). boot = render at once from loadSync(), then apply the
// authoritative value with hydrate(). When the authority is empty (first run / existing user), the
// localStorage cache is migrated to app.data once.

const NS = "core";

export interface CoreStoreDeps {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  onDataChange: (cb: (key: string) => void) => () => void;
  localStorage: Pick<Storage, "getItem" | "setItem">;
}

export interface CoreStoreOpts<T> extends CoreStoreDeps {
  /** kv key inside the core ns (e.g. "settings", "theme", "layout/main/<root>"). */
  key: string;
  /** localStorage key for the sync boot cache (existing keys are kept, so migration is seamless). */
  lsKey: string;
  fallback: T;
}

export interface CoreStore<T> {
  /** Synchronous, before render — the localStorage cache (fallback when absent). */
  loadSync: () => T;
  /** Sets the value this window just wrote as the in-memory authority at once (read-your-writes).
   *  Does not flush to disk (app.data) — the caller (coreSync) flushes on a debounce. While staged,
   *  hydrate/subscribe treat this value as the authority (a disk value that is still old does not
   *  overwrite it as stale). save = stage + immediate flush. */
  stage: (value: T) => void;
  /** Writes both the authority (app.data) and the cache (localStorage). */
  save: (value: T) => Promise<void>;
  /** Reads the authoritative value, refreshes the cache, then returns it. When the authority is
   *  empty, the cache is moved into it **only when the cache has content**. */
  hydrate: () => Promise<T>;
  /** Whether the authority **has** this key, and its value. Absent gives `found:false` and the
   *  fallback as the value.
   *
   *  This is where absent and empty are separated. A consumer that reads the two the same way
   *  deletes assets — window respawn deleted a ledger slot on `projects.length === 0`, and a
   *  window with no snapshot gave the same answer as a window the user emptied, so that window
   *  never opened again (measured 2026-08-01). Throws when it cannot read. */
  read: () => Promise<{ found: boolean; value: T }>;
  /** Calls back with the latest authoritative value when another window emits a data-change for
   *  the same key. Returns the unsubscribe function. */
  subscribe: (cb: (value: T) => void) => () => void;
}

export function makeCoreStore<T>(opts: CoreStoreOpts<T>): CoreStore<T> {
  const { key, lsKey, fallback, invoke, onDataChange, localStorage } = opts;

  // The value this window just wrote (serialized). The sending window receives the data-change
  // broadcast too (commands.rs emits to every window), so running readRemote→apply on that
  // self-echo costs one more unnecessary re-render. Skip when it equals lastSavedJson.
  let lastSavedJson: string | null = null;

  // In-memory authority (read-your-writes): the value this window just wrote. The app.data (SQLite)
  // flush can be deferred by the debounce, so disk holds the old value for a while — later reads in
  // this window must treat this staged value as the authority. dirty = before the disk flush (the
  // local write is newer than SQLite). Clearing dirty when the flush (save) completes → disk is the
  // authority from then on.
  let staged: T | null = null;
  let dirty = false;

  const writeCache = (value: T) => {
    try {
      localStorage.setItem(lsKey, JSON.stringify(value));
    } catch {
      /* A failed cache write is not fatal (app.data is the authority) */
    }
  };

  const loadSync = (): T => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  // The measured disk (SQLite) value. subscribe detects another window's change with it (staged is
  // ignored — this is for determining the newest external value).
  const readRemote = async (): Promise<T | null> => {
    const v = (await invoke("data_kv_get", { ns: NS, key })) as T | null;
    return v ?? null;
  };

  const stage = (value: T): void => {
    lastSavedJson = JSON.stringify(value); // this value's echo is self — subscribe skips it
    staged = value; // in-memory authority at once (read-your-writes)
    dirty = true; // before the disk flush — the local write is newer than SQLite
    writeCache(value); // synchronous cache (boot crash-safe) at once too
  };

  const save = async (value: T): Promise<void> => {
    stage(value);
    await invoke("data_kv_set", { ns: NS, key, value });
    dirty = false; // SQLite == staged — disk is the authority now
  };

  const read = async (): Promise<{ found: boolean; value: T }> => {
    // read-your-writes: an unflushed local write (dirty) is newer than stale SQLite — the value
    // just written is the authority.
    if (dirty && staged != null) return { found: true, value: staged };
    const remote = await readRemote();
    if (remote != null) {
      staged = remote;
      writeCache(remote);
      return { found: true, value: remote };
    }
    return { found: false, value: loadSync() };
  };

  const hydrate = async (): Promise<T> => {
    const { found, value } = await read();
    if (found) return value;
    // The authority is empty — the cache is moved into it **only when the cache has content**
    // (seamless transfer).
    //
    // Writing an empty fallback to the authority fixes "not there yet" as "empty" at that moment,
    // and a consumer reading it treats it as emptied by the user — window respawn deleted a ledger
    // slot on that answer. Nothing to write means no write.
    if (JSON.stringify(value) !== JSON.stringify(fallback)) {
      await invoke("data_kv_set", { ns: NS, key, value });
    }
    staged = value;
    return value;
  };

  const subscribe = (cb: (value: T) => void): (() => void) =>
    onDataChange((changedKey) => {
      if (changedKey !== key) return;
      void readRemote().then((v) => {
        if (v == null) return;
        // A self-echo (the value this window just wrote) is already in the store and cache — skip
        // the re-apply (re-render).
        if (JSON.stringify(v) === lastSavedJson) return;
        // read-your-writes: while an unflushed local write is in progress, disk still holds the old
        // value — that stale echo must not revert the value just written (the debounced flush
        // updates SQLite and broadcasts shortly).
        if (dirty) return;
        staged = v; // adopt another window's newer external value
        writeCache(v);
        cb(v);
      });
    });

  return { loadSync, stage, save, hydrate, read, subscribe };
}
