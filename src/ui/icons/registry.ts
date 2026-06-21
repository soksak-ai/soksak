// 아이콘 셋 레지스트리 — viewRegistry 와 동형(zustand + version 카운터).
// 내장 lucide 는 항상 존재하는 폴백: 선택된 셋이 없거나(플러그인 비활성/제거)
// 이름이 비어도 UI 는 성립한다.

import { create } from "zustand";
import { ICON_NAMES, type IconGlyph, type IconName, type IconSetData } from "./types";
import { LUCIDE_ICONS } from "./sets/lucide";

export const BUILTIN_ICON_SET = "lucide";

export interface RegisteredIconSet {
  id: string;
  /** 표시 이름(설정 드롭다운) */
  name: string;
  data: IconSetData;
}

interface IconRegistryState {
  sets: Record<string, RegisteredIconSet>;
  version: number;
  register: (set: RegisteredIconSet) => void;
  unregister: (id: string) => void;
}

export const useIconRegistry = create<IconRegistryState>((set) => ({
  sets: {
    [BUILTIN_ICON_SET]: { id: BUILTIN_ICON_SET, name: "Lucide", data: LUCIDE_ICONS },
  },
  version: 1,
  register: (s) =>
    set((st) => ({
      sets: { ...st.sets, [s.id]: s },
      version: st.version + 1,
    })),
  unregister: (id) =>
    set((st) => {
      if (id === BUILTIN_ICON_SET) return st; // 내장 폴백은 제거 불가
      if (!(id in st.sets)) return st;
      const next = { ...st.sets };
      delete next[id];
      return { sets: next, version: st.version + 1 };
    }),
}));

// 셋 데이터 검증 — 전 시맨틱 이름을 제공해야 등록 가능(부분 셋이면 어느 이름이
// 비었는지 메시지로 반환). 플러그인 입력 방어.
export function validateIconSetData(data: unknown): string | null {
  if (!data || typeof data !== "object") return "셋 데이터가 객체가 아님";
  const d = data as Record<string, Partial<IconGlyph>>;
  for (const name of ICON_NAMES) {
    const g = d[name];
    if (!g || typeof g !== "object") return `아이콘 누락: ${name}`;
    if (typeof g.v !== "string" || !g.v.trim()) return `${name}: viewBox(v) 누락`;
    if (typeof g.b !== "string" || !g.b.trim()) return `${name}: 본문(b) 누락`;
    if (g.f !== "stroke" && g.f !== "fill" && g.f !== "both")
      return `${name}: 렌더 모드(f)는 stroke|fill|both`;
  }
  return null;
}

/** setId 의 글리프 — 셋/이름이 없으면 내장 lucide 로 폴백. */
export function getIconGlyph(setId: string, name: IconName): IconGlyph {
  const sets = useIconRegistry.getState().sets;
  return sets[setId]?.data[name] ?? LUCIDE_ICONS[name];
}

// 이 플러그인이 실제 등록한 셋 id(declared≡actual 의 actual). 전역 id="<pluginId>.<setId>" →
// setId 만 반환. 내장 lucide(prefix 없음)는 자동 제외. plugin id 는 점 불포함이라 prefix 분리 안전.
export function registeredIconSetIds(pluginId: string): string[] {
  const prefix = `${pluginId}.`;
  return Object.values(useIconRegistry.getState().sets)
    .filter((s) => s.id.startsWith(prefix))
    .map((s) => s.id.slice(prefix.length));
}
