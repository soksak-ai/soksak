// 플러그인 스토어 — 스캔/설치/동의/활성화 상태의 단일 저장소(테마 스토어 대칭).
//   - 검증: parseManifest(스펙 단일진실) all-or-nothing — 불량은 rejected 로 노출.
//   - 동의(§0-5): 활성화 전 사람의 동의 기록 필수. 버전/권한이 바뀌면 재동의.
//   - 활성 인스턴스(모듈/Disposable — 비직렬화)는 loader 의 Map 에 보관, 여기는
//     직렬화 가능한 런타임 상태만 담는다(plugin.list 가 그대로 나르는 형태).

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  parseManifest,
  semverGte,
  type PluginManifest,
  type PluginPermission,
} from "../plugins/spec";
import {
  activatePlugin,
  deactivateAll,
  deactivateById,
  importPluginModule,
  isActive,
  setActive,
} from "../plugins/loader";
import { defaultPluginDeps } from "../plugins/deps";
import { err, ok, type CmdResult } from "./sessions";

export interface PluginRuntime {
  manifest: PluginManifest;
  dir: string;
  source: "installed" | "dev";
  status: "disabled" | "enabled" | "error";
  error?: string;
}

export interface RejectedPlugin {
  dir: string;
  errors: string[];
}

export interface ConsentRecord {
  version: string;
  permissions: PluginPermission[];
}

interface PluginScanEntry {
  dir: string;
  dir_name: string;
  manifest: string | null;
  error: string | null;
}

interface PluginsState {
  appVersion: string; // initPluginHost 가 채움("0.0.0" = 미확인)
  plugins: Record<string, PluginRuntime>;
  rejected: RejectedPlugin[];
  consents: Record<string, ConsentRecord>; // localStorage 영속
  enabledIds: string[]; // localStorage 영속 — 재시작 시 재활성화 대상
  reload: () => Promise<void>;
  install: (
    source: string,
    reference?: string,
  ) => Promise<CmdResult<{ id: string; dir: string }>>;
  update: (id: string) => Promise<CmdResult<{ id: string; version: string }>>;
  remove: (id: string) => Promise<CmdResult<{ id: string }>>;
  enable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  disable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  // 동의 기록 — UI(동의 모달)만 호출한다. 명령으로 노출하지 않는다(§0-5).
  grantConsent: (id: string) => boolean;
  devLoad: (path: string) => Promise<CmdResult<{ id: string; dir: string }>>;
}

const KEY = "soksak.plugins";

function loadPersisted(): {
  consents: Record<string, ConsentRecord>;
  enabledIds: string[];
} {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        consents: parsed.consents ?? {},
        enabledIds: Array.isArray(parsed.enabledIds) ? parsed.enabledIds : [],
      };
    }
  } catch {
    // 손상 시 기본값 — 동의는 보수적으로 초기화(재동의 요구가 안전).
  }
  return { consents: {}, enabledIds: [] };
}

function samePermissions(
  a: PluginPermission[],
  b: PluginPermission[],
): boolean {
  return (
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",")
  );
}

export function consentValid(
  consent: ConsentRecord | undefined,
  manifest: PluginManifest,
): boolean {
  return (
    !!consent &&
    consent.version === manifest.version &&
    samePermissions(consent.permissions, manifest.permissions)
  );
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export const usePlugins = create<PluginsState>((set, get) => {
  const persisted = loadPersisted();

  const persist = () => {
    const s = get();
    localStorage.setItem(
      KEY,
      JSON.stringify({ consents: s.consents, enabledIds: s.enabledIds }),
    );
  };

  const setRuntime = (id: string, patch: Partial<PluginRuntime>) => {
    set((s) => {
      const cur = s.plugins[id];
      if (!cur) return s;
      return { plugins: { ...s.plugins, [id]: { ...cur, ...patch } } };
    });
  };

  // manifest 원문 → 런타임(검증 통과) 또는 rejected 사유.
  const parseRuntime = (
    rawText: string,
    dir: string,
    dirName: string,
    source: "installed" | "dev",
    rejected: RejectedPlugin[],
  ): PluginRuntime | null => {
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (e) {
      rejected.push({ dir, errors: [`plugin.json 파싱 실패: ${e}`] });
      return null;
    }
    const { manifest, validation } = parseManifest(raw, dirName);
    if (!manifest) {
      rejected.push({ dir, errors: validation.errors });
      return null;
    }
    const appVersion = get().appVersion;
    if (manifest.minAppVersion) {
      if (appVersion === "0.0.0") {
        console.warn(
          `앱 버전 미확인 — ${manifest.id} 의 minAppVersion(${manifest.minAppVersion}) 검사 생략`,
        );
      } else if (semverGte(appVersion, manifest.minAppVersion) === false) {
        rejected.push({
          dir,
          errors: [
            `앱 버전 미달: 요구 ${manifest.minAppVersion} > 현재 ${appVersion}`,
          ],
        });
        return null;
      }
    }
    return { manifest, dir, source, status: "disabled" };
  };

  // entry 적재 → 활성화 → 인스턴스 보관. 실패는 throw(호출부가 상태 기록).
  const activateRuntime = async (p: PluginRuntime): Promise<void> => {
    const data = await invoke<{ content: string }>("read_text_file", {
      path: `${p.dir}/${p.manifest.entry}`,
    });
    const module = await importPluginModule(data.content);
    const instance = await activatePlugin(
      module,
      p.manifest,
      p.dir,
      defaultPluginDeps(get().appVersion),
    );
    setActive(p.manifest.id, instance);
  };

  return {
    appVersion: "0.0.0",
    plugins: {},
    rejected: [],
    consents: persisted.consents,
    enabledIds: persisted.enabledIds,

    reload: async () => {
      // 전체 재시작: 활성 인스턴스 전부 내리고 다시 스캔 — 부분 상태 금지(§0-3).
      await deactivateAll();
      const entries = await invoke<PluginScanEntry[]>("plugins_scan");
      const rejected: RejectedPlugin[] = [];
      const next: Record<string, PluginRuntime> = {};

      for (const e of entries) {
        if (e.manifest == null) {
          rejected.push({ dir: e.dir, errors: [e.error ?? "manifest 없음"] });
          continue;
        }
        const rt = parseRuntime(e.manifest, e.dir, e.dir_name, "installed", rejected);
        if (rt) next[rt.manifest.id] = rt;
      }

      // dev 플러그인: 디렉토리에서 manifest 재독(개발 반복 반영). 실패 시 rejected.
      for (const p of Object.values(get().plugins)) {
        if (p.source !== "dev") continue;
        try {
          const data = await invoke<{ content: string }>("read_text_file", {
            path: `${p.dir}/plugin.json`,
          });
          const rt = parseRuntime(
            data.content,
            p.dir,
            basename(p.dir),
            "dev",
            rejected,
          );
          // dev 가 동명 설치본을 가린다(테마의 외부 우선 모델과 동일 — 개발 편의).
          if (rt) next[rt.manifest.id] = rt;
        } catch (e2) {
          rejected.push({ dir: p.dir, errors: [`dev 재독 실패: ${e2}`] });
        }
      }

      set({ plugins: next, rejected });

      // 동의 유효한 enabled 목록 재활성화. 실패는 status 로 표시(§0-4 — 침묵 금지).
      for (const id of get().enabledIds) {
        const p = get().plugins[id];
        if (!p) continue;
        // dev 소스는 동의 게이트 면제(§0-5 예외 — enable 과 동일 규칙).
        if (
          p.source !== "dev" &&
          !consentValid(get().consents[id], p.manifest)
        ) {
          setRuntime(id, {
            status: "disabled",
            error: "재동의 필요(버전 또는 권한 변경)",
          });
          continue;
        }
        try {
          await activateRuntime(p);
          setRuntime(id, { status: "enabled", error: undefined });
        } catch (e) {
          setRuntime(id, { status: "error", error: String(e) });
        }
      }
    },

    install: async (source, reference) => {
      const r = await invoke<{ dir: string; dir_name: string }>(
        "plugin_install_git",
        { source, reference },
      );
      await get().reload();
      const rt = get().plugins[r.dir_name];
      if (!rt) {
        const rej = get().rejected.find((x) => x.dir === r.dir);
        return err(
          "INVALID_PARAMS",
          `설치됨(${r.dir})이나 매니페스트 검증 실패: ${rej?.errors.join("; ") ?? "사유 불명"}`,
        );
      }
      return ok({ id: r.dir_name, dir: r.dir });
    },

    update: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      if (p.source === "dev") {
        return err("INVALID_PARAMS", "dev 플러그인은 update 대상이 아님");
      }
      if (isActive(id)) await get().disable(id);
      await invoke("plugin_update", { id });
      await get().reload();
      const after = get().plugins[id];
      if (!after) {
        const rej = get().rejected.find((x) => x.dir === p.dir);
        return err(
          "INVALID_PARAMS",
          `갱신됐으나 검증 실패: ${rej?.errors.join("; ") ?? "사유 불명"}`,
        );
      }
      return ok({ id, version: after.manifest.version });
    },

    remove: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      if (p.source === "dev") {
        // dev 는 디스크 삭제 없이 목록에서만 내린다.
        if (isActive(id)) await deactivateById(id);
        set((s) => {
          const plugins = { ...s.plugins };
          delete plugins[id];
          return {
            plugins,
            enabledIds: s.enabledIds.filter((x) => x !== id),
          };
        });
        persist();
        return ok({ id });
      }
      if (isActive(id)) await get().disable(id);
      await invoke("plugin_remove", { id });
      set((s) => {
        const consents = { ...s.consents };
        delete consents[id];
        return {
          consents,
          enabledIds: s.enabledIds.filter((x) => x !== id),
        };
      });
      persist();
      await get().reload();
      return ok({ id });
    },

    enable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      if (p.status === "enabled" && isActive(id)) {
        return ok({ id, status: "enabled" }); // 멱등
      }
      // dev 소스는 동의 게이트 면제(§0-5 예외) — 개발자가 경로를 직접 지정해
      // 적재한 자기 작업물이고, 게이트는 적재 명령(danger:"inject")에 있다.
      if (
        p.source !== "dev" &&
        !consentValid(get().consents[id], p.manifest)
      ) {
        return err(
          "CONSENT_REQUIRED",
          `활성화 동의 필요: ${id} — 설정(우측 사이드바 관리)에서 권한을 확인하고 동의`,
        );
      }
      try {
        await activateRuntime(p);
      } catch (e) {
        setRuntime(id, { status: "error", error: String(e) });
        throw e; // 명령 레이어가 INTERNAL 로 변환, UI 는 status 로 표시.
      }
      setRuntime(id, { status: "enabled", error: undefined });
      if (!get().enabledIds.includes(id)) {
        set((s) => ({ enabledIds: [...s.enabledIds, id] }));
      }
      persist();
      return ok({ id, status: "enabled" });
    },

    disable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      await deactivateById(id);
      setRuntime(id, { status: "disabled", error: undefined });
      set((s) => ({ enabledIds: s.enabledIds.filter((x) => x !== id) }));
      persist();
      return ok({ id, status: "disabled" });
    },

    grantConsent: (id) => {
      const p = get().plugins[id];
      if (!p) return false;
      set((s) => ({
        consents: {
          ...s.consents,
          [id]: {
            version: p.manifest.version,
            permissions: [...p.manifest.permissions],
          },
        },
      }));
      persist();
      return true;
    },

    devLoad: async (path) => {
      const dirName = basename(path);
      let content: string;
      try {
        const data = await invoke<{ content: string }>("read_text_file", {
          path: `${path}/plugin.json`,
        });
        content = data.content;
      } catch (e) {
        return err("TARGET_NOT_FOUND", `plugin.json 읽기 실패: ${e}`);
      }
      const rejected: RejectedPlugin[] = [];
      const rt = parseRuntime(content, path, dirName, "dev", rejected);
      if (!rt) {
        return err(
          "INVALID_PARAMS",
          `매니페스트 검증 실패: ${rejected[0]?.errors.join("; ")}`,
        );
      }
      const id = rt.manifest.id;
      if (isActive(id)) await deactivateById(id);
      set((s) => ({ plugins: { ...s.plugins, [id]: rt } }));
      return ok({ id, dir: path });
    },
  };
});
