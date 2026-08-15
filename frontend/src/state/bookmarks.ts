import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// Browser bookmarks (global) — app.data is authoritative, ls is the sync cache (coreSync), consistent across windows.

export interface Bookmark {
  url: string;
  title: string;
}

interface BookmarksState {
  list: Bookmark[];
  has: (url: string) => boolean;
  toggle: (url: string, title: string) => void;
  remove: (url: string) => void;
}

const KEY = "soksak.bookmarks";

const bookmarksSync = createCoreSync<Bookmark[]>({
  key: "bookmarks",
  lsKey: KEY,
  fallback: [],
  apply: (list) => useBookmarks.setState({ list: Array.isArray(list) ? list : [] }),
});
export const initBookmarksPersistence = (deps: CoreStoreDeps): (() => void) =>
  bookmarksSync.init(deps);

function load(): Bookmark[] {
  const v = bookmarksSync.loadSync();
  return Array.isArray(v) ? v : [];
}

// The store is held outside the module boundary — a hot swap that replaces it makes registration, subscription,
// and screen state all new, while the filling side has already recorded the fill and never repeats it (empty forever).
export const useBookmarks = moduleState("state/bookmarks#store", () =>
  create<BookmarksState>((set, get) => {
  const save = (list: Bookmark[]) => {
    bookmarksSync.save(list);
    set({ list });
  };
  return {
    list: load(),
    has: (url) => get().list.some((b) => b.url === url),
    toggle: (url, title) => {
      const list = get().list;
      if (list.some((b) => b.url === url)) {
        save(list.filter((b) => b.url !== url));
      } else {
        save([...list, { url, title }]);
      }
    },
    remove: (url) => save(get().list.filter((b) => b.url !== url)),
  };
}),
);
