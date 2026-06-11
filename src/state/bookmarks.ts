import { create } from "zustand";

// 브라우저 즐겨찾기(전역, localStorage 영속).

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

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const useBookmarks = create<BookmarksState>((set, get) => {
  const save = (list: Bookmark[]) => {
    localStorage.setItem(KEY, JSON.stringify(list));
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
});
