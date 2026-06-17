// 인앱 알림 배너 스토어 — 앱이 포커스 상태일 때의 알림 표시(비포커스는 OS 알림). 창마다 자체
// store(멀티윈도우) — push 를 호출한 그 창에만 배너가 뜬다(클릭 단일 처리). 최근 N개만 유지.

import { create } from "zustand";

export interface NotifyAction {
  label: string;
  deepLink: string; // soksak://cmd/...
}

export interface NotifyBanner {
  id: string;
  title: string;
  body?: string;
  icon?: string; // 글리프/이모지
  image?: string; // URL/asset 경로(썸네일)
  deepLink?: string; // 본문 클릭 시 활성화할 command URI
  actions?: NotifyAction[];
}

const MAX_VISIBLE = 4;

interface NotifyState {
  banners: NotifyBanner[];
  show: (b: NotifyBanner) => void;
  dismiss: (id: string) => void;
}

export const useNotify = create<NotifyState>((set) => ({
  banners: [],
  // 같은 id 는 교체(중복 제거), 최근 MAX_VISIBLE 개만.
  show: (b) =>
    set((s) => ({
      banners: [...s.banners.filter((x) => x.id !== b.id), b].slice(-MAX_VISIBLE),
    })),
  dismiss: (id) => set((s) => ({ banners: s.banners.filter((x) => x.id !== id) })),
}));
