import { create } from "zustand";
import {
  mergeRegistry,
  parseRegistry,
  REGISTRY_SPEC,
  type Registry,
  type RegistryEntry,
} from "../plugins/registry";
import snapshotRaw from "../plugins/registrySnapshot.json";

// 공식 플러그인 "설치 가능 목록" store. 빌드 스냅샷으로 즉시 표시(첫 실행/오프라인), 세션 1회 +
// 사용자 새로고침 시 원격 레지스트리(registry.json)를 fetch 해 최신화. 원격 실패면 스냅샷 유지.
//
// 원격 URL = 전용 레지스트리 레포의 raw registry.json. (Phase B 에서 레포 생성 후 실 배선 — 그 전엔
// fetch 가 실패해 status="error" + 스냅샷 폴백으로 동작한다.)
const REMOTE_URL =
  "https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json";

const SNAPSHOT: Registry = parseRegistry(snapshotRaw) ?? { spec: REGISTRY_SPEC, plugins: [] };

export type RegistryStatus = "snapshot" | "fetching" | "live" | "error";

interface RegistryState {
  entries: RegistryEntry[];
  status: RegistryStatus;
  fetchedOnce: boolean;
  // 원격 갱신. 기본은 세션 1회(이미 fetch 했으면 skip), force=true 면 사용자 새로고침으로 재시도.
  refresh: (force?: boolean) => Promise<void>;
}

export const useRegistry = create<RegistryState>((set, get) => ({
  entries: SNAPSHOT.plugins,
  status: "snapshot",
  fetchedOnce: false,
  refresh: async (force = false) => {
    const s = get();
    if (s.status === "fetching") return;
    if (s.fetchedOnce && !force) return;
    set({ status: "fetching" });
    try {
      const res = await fetch(REMOTE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      const merged = mergeRegistry(SNAPSHOT, raw);
      set({ entries: merged.plugins, status: "live", fetchedOnce: true });
    } catch {
      // 오프라인/미배선/손상 — 스냅샷 유지(entries 불변), 상태만 error.
      set({ status: "error", fetchedOnce: true });
    }
  },
}));
