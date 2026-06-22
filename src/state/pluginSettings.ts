import { create } from "zustand";
import type { MapEntry } from "../plugins/spec";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 플러그인 사용자 설정 — 글로벌(앱 전역) + 프로젝트별 오버라이드 2계층.
// 저장은 "오버라이드된 값"만(기본값은 매니페스트 configuration 이 단일 진실 — 여기 안 둔다).
// effective = 프로젝트 오버라이드 ?? 글로벌 ?? 스키마 기본(호출부가 def 로 넘김).
//
// 프로젝트 정체성 = root 경로(ProjectTab.root, P4) — 세션-스코프 tab id 가 아니라 영속 키.

// list(문자열 배열)·map({key,value} 배열) 타입 설정값 포함 — 설정 모달이 행별 add/remove 로 편집.
export type SettingValue = boolean | number | string | string[] | MapEntry[];
// [pluginId][key] → 값
type Bag = Record<string, Record<string, SettingValue>>;

interface PluginSettingsState {
  global: Bag;
  byProject: Record<string, Bag>; // [projectRoot][pluginId][key]
  getGlobal: (pluginId: string, key: string) => SettingValue | undefined;
  getProject: (root: string, pluginId: string, key: string) => SettingValue | undefined;
  setGlobal: (pluginId: string, key: string, value: SettingValue) => void;
  setProject: (root: string, pluginId: string, key: string, value: SettingValue) => void;
  // key 생략 = 그 플러그인의 해당 스코프 오버라이드 전체 제거(기본값 복원).
  resetGlobal: (pluginId: string, key?: string) => void;
  resetProject: (root: string, pluginId: string, key?: string) => void;
  effective: (pluginId: string, key: string, def: SettingValue, root?: string) => SettingValue;
  allEffective: (
    pluginId: string,
    defaults: Record<string, SettingValue>,
    root?: string,
  ) => Record<string, SettingValue>;
}

const KEY = "soksak.pluginSettings";

type PluginSettingsBlob = { global: Bag; byProject: Record<string, Bag> };
const EMPTY: PluginSettingsBlob = { global: {}, byProject: {} };

const pluginSettingsSync = createCoreSync<PluginSettingsBlob>({
  key: "pluginSettings",
  lsKey: KEY,
  fallback: EMPTY,
  apply: (v) =>
    usePluginSettings.setState({
      global: v?.global ?? {},
      byProject: v?.byProject ?? {},
    }),
});
export const initPluginSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  pluginSettingsSync.init(deps);

function load(): PluginSettingsBlob {
  const v = pluginSettingsSync.loadSync();
  return { global: v?.global ?? {}, byProject: v?.byProject ?? {} };
}

// 불변 nested set — 새 객체로 갈아끼워 zustand 구독자가 깬다.
function bagSet(bag: Bag, pluginId: string, key: string, value: SettingValue): Bag {
  return { ...bag, [pluginId]: { ...(bag[pluginId] ?? {}), [key]: value } };
}
// key 있으면 그 키만, 없으면 플러그인 전체 제거.
function bagDelete(bag: Bag, pluginId: string, key?: string): Bag {
  if (!(pluginId in bag)) return bag;
  if (key === undefined) {
    const next = { ...bag };
    delete next[pluginId];
    return next;
  }
  const inner = { ...(bag[pluginId] ?? {}) };
  delete inner[key];
  return { ...bag, [pluginId]: inner };
}

export const usePluginSettings = create<PluginSettingsState>((set, get) => {
  const persist = () => {
    const s = get();
    pluginSettingsSync.save({ global: s.global, byProject: s.byProject });
  };
  const init = load();
  return {
    global: init.global,
    byProject: init.byProject,
    getGlobal: (pluginId, key) => get().global[pluginId]?.[key],
    getProject: (root, pluginId, key) => get().byProject[root]?.[pluginId]?.[key],
    setGlobal: (pluginId, key, value) => {
      set((s) => ({ global: bagSet(s.global, pluginId, key, value) }));
      persist();
    },
    setProject: (root, pluginId, key, value) => {
      set((s) => ({
        byProject: { ...s.byProject, [root]: bagSet(s.byProject[root] ?? {}, pluginId, key, value) },
      }));
      persist();
    },
    resetGlobal: (pluginId, key) => {
      set((s) => ({ global: bagDelete(s.global, pluginId, key) }));
      persist();
    },
    resetProject: (root, pluginId, key) => {
      set((s) => {
        if (!s.byProject[root]) return s;
        return { byProject: { ...s.byProject, [root]: bagDelete(s.byProject[root], pluginId, key) } };
      });
      persist();
    },
    effective: (pluginId, key, def, root) => {
      const s = get();
      const proj = root ? s.byProject[root]?.[pluginId]?.[key] : undefined;
      if (proj !== undefined) return proj;
      const glob = s.global[pluginId]?.[key];
      if (glob !== undefined) return glob;
      return def;
    },
    allEffective: (pluginId, defaults, root) => {
      const out: Record<string, SettingValue> = {};
      for (const k of Object.keys(defaults)) {
        out[k] = get().effective(pluginId, k, defaults[k], root);
      }
      return out;
    },
  };
});
