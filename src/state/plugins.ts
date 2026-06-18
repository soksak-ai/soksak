// 플러그인 스토어 — 스캔/설치/동의/활성화 상태의 단일 저장소(테마 스토어 대칭).
//   - 검증: parseManifest(스펙 단일진실) all-or-nothing — 불량은 rejected 로 노출.
//   - 동의(§0-5): 활성화 전 사람의 동의 기록 필수. 버전/권한이 바뀌면 재동의.
//   - 활성 인스턴스(모듈/Disposable — 비직렬화)는 loader 의 Map 에 보관, 여기는
//     직렬화 가능한 런타임 상태만 담는다(plugin.list 가 그대로 나르는 형태).

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  parseManifest,
  scanHostChromeViolations,
  semverGte,
  type LibraryDep,
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
import {
  allMissingDeps,
  cascadeRemovalSet,
  transitiveDependents,
  type DepNode,
} from "../plugins/dependencyGraph";
import { useRegistry } from "./registry";
import { err, ok, useSessions, type CmdResult } from "./sessions";

// 설치/dev 런타임 → 의존 그래프 노드(매니페스트 dependencies 기준). 리졸버가 소비.
function pluginDepNodes(plugins: Record<string, PluginRuntime>): DepNode[] {
  return Object.values(plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
}
import { installCommandFor, libraryInstallFor } from "../plugins/programRegistry";

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
  ) => Promise<
    CmdResult<{
      id: string;
      dir: string;
      installedDeps?: string[]; // 전이적으로 동반 설치된 의존 id
      unresolvedDeps?: string[]; // 레지스트리에 없어 못 깐 의존 id(침묵 금지 — 보고)
    }>
  >;
  update: (id: string) => Promise<CmdResult<{ id: string; version: string }>>;
  // cascade:true 면 의존자(전이)까지 함께 삭제. 미지정 + 의존자 존재 시 CASCADE_REQUIRED 로 차단.
  remove: (
    id: string,
    opts?: { cascade?: boolean },
  ) => Promise<CmdResult<{ id: string; removed?: string[] }>>;
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

// 프로그램 ensure(§2.6) — 활성화 시점에 선행 바이너리를 보장한다. 사용자
// 로그인 셸 PATH 로 확인(shell_which)하고, 미설치면 공식 설치 명령을 새
// 터미널 탭에서 가시 실행한다(은폐 금지 — 동의 화면에 고지된 그 명령 그대로).
// 실패는 콘솔로만(§0-4 — 플러그인 활성화 자체를 막지 않는다).
async function ensureProgramBinaries(manifest: PluginManifest): Promise<void> {
  for (const prog of manifest.contributes.programs) {
    if (!prog.ensure) continue;
    const install = installCommandFor(prog);
    if (!install) continue; // 이 플랫폼 설치 명령 미제공
    try {
      const found = await invoke<boolean>("shell_which", {
        bin: prog.ensure.bin,
      });
      if (found) continue;
      const s = useSessions.getState();
      s.addViewToGroup(s.activeId, "terminal", undefined, {
        command: `${install}; echo "[soksak] ${prog.ensure.bin} 설치 종료 — + 메뉴에서 선택해 실행하세요"`,
      });
    } catch (e) {
      console.error(`ensure 실패(${manifest.id}/${prog.id}):`, e);
    }
  }
}

// 라이브러리 종속성(§libraries) 전이 수집 — 이 매니페스트 + 전이 플러그인 deps 의 libraries.
// 라이브러리를 소유한 플러그인(예: core)에 의존하는 플러그인을 활성화해도 그 CLI 가 보장된다.
// bin 기준 중복 제거(같은 CLI 를 두 번 안 깐다). plugins 키 = 설치 디렉토리명 = 플러그인 id.
export function transitiveLibraries(
  manifest: PluginManifest,
  plugins: Record<string, PluginRuntime>,
): LibraryDep[] {
  const seenBin = new Set<string>();
  const seenPlugin = new Set<string>();
  const out: LibraryDep[] = [];
  const visit = (m: PluginManifest) => {
    if (seenPlugin.has(m.id)) return; // 순환 방어
    seenPlugin.add(m.id);
    for (const lib of m.libraries ?? []) {
      if (!seenBin.has(lib.bin)) {
        seenBin.add(lib.bin);
        out.push(lib);
      }
    }
    for (const depId of Object.keys(m.dependencies ?? {})) {
      const dep = plugins[depId];
      if (dep) visit(dep.manifest);
    }
  };
  visit(manifest);
  return out;
}

// 라이브러리 종속성 강제 설치 — 활성화 시점에 전이 libraries 를 보장한다. 로그인 셸 PATH 로
// 확인(shell_which)하고, 미설치분을 한 터미널에서 가시 설치한다(은폐 금지 — 동의 화면에
// 고지된 그 명령 그대로). 실패는 콘솔로만(§0-4 — 활성화 자체를 막지 않는다).
async function ensureLibraries(
  manifest: PluginManifest,
  plugins: Record<string, PluginRuntime>,
): Promise<void> {
  const libs = transitiveLibraries(manifest, plugins);
  const toInstall: string[] = [];
  for (const lib of libs) {
    const install = libraryInstallFor(lib);
    if (!install) continue; // 이 플랫폼 설치 명령 미제공
    try {
      const found = await invoke<boolean>("shell_which", { bin: lib.bin });
      if (!found) toInstall.push(install);
    } catch (e) {
      console.error(`라이브러리 ensure 검사 실패(${manifest.id}/${lib.bin}):`, e);
    }
  }
  if (toInstall.length === 0) return;
  const s = useSessions.getState();
  s.addViewToGroup(s.activeId, "terminal", undefined, {
    command: `${toInstall.join(" && ")}; echo "[soksak] 라이브러리 종속성 설치 종료"`,
  });
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
    // 크롬 표준 게이트 — 번들 CSS 가 호스트 크롬 셀렉터/변수를 덮으면 탭 정렬이 깨진다. 명백한 정적 위반은
    // 거부(침묵 실패 금지). 사이드바/컨텐츠 뷰가 있는 플러그인에만 적용 — 뷰 없는 플러그인은 크롬 무관.
    if (p.manifest.contributes.views.length > 0) {
      const violations = scanHostChromeViolations(data.content);
      if (violations.length > 0) {
        throw new Error(
          `호스트 크롬 표준 위반(${p.manifest.id}): 플러그인 CSS 가 호스트 소유 셀렉터/변수를 덮습니다 — ${violations.join(", ")}. 자기 클래스만 스타일링하세요(탭/헤더 높이는 호스트가 소유).`,
        );
      }
    }
    const module = await importPluginModule(data.content);
    const instance = await activatePlugin(
      module,
      p.manifest,
      p.dir,
      defaultPluginDeps(get().appVersion),
    );
    setActive(p.manifest.id, instance);
  };

  // 단일 제거 — dev 는 목록에서만, installed 는 디스크째. consent/enabled 정리. cascade 의 단위.
  // reload 는 하지 않는다(cascade 호출부가 루프 끝에 1회) — 루프 중 그래프가 흔들리지 않게.
  const removeSingle = async (id: string): Promise<CmdResult<{ id: string }>> => {
    const p = get().plugins[id];
    if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
    if (p.source === "dev") {
      if (isActive(id)) await deactivateById(id);
      set((s) => {
        const plugins = { ...s.plugins };
        delete plugins[id];
        return { plugins, enabledIds: s.enabledIds.filter((x) => x !== id) };
      });
      persist();
      return ok({ id });
    }
    if (isActive(id)) await get().disable(id);
    await invoke("plugin_remove", { id });
    set((s) => {
      const consents = { ...s.consents };
      delete consents[id];
      return { consents, enabledIds: s.enabledIds.filter((x) => x !== id) };
    });
    persist();
    return ok({ id });
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
        // 템플릿은 활성화하지 않는다(enable 게이트로 enabledIds 에 못 들지만,
        // 설치본이 template 으로 바뀐 경우를 대비한 방어).
        if (p.manifest.template) {
          setRuntime(id, { status: "disabled", error: undefined });
          continue;
        }
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
      // 전이 의존 자동 동반 설치 — 미설치 의존을 레지스트리에서 찾아 clone. fixpoint(새 dep 의 dep 까지).
      const registry = useRegistry.getState().entries;
      const installedDeps: string[] = [];
      for (let guard = 0; guard < 50; guard++) {
        const missing = allMissingDeps(pluginDepNodes(get().plugins));
        if (missing.length === 0) break;
        let progressed = false;
        for (const m of missing) {
          const entry = registry.find((e) => e.id === m.id);
          if (!entry) continue; // 소스 모름 — 루프 후 unresolved 로 보고
          try {
            const dr = await invoke<{ dir_name: string }>("plugin_install_git", {
              source: entry.repo,
              reference: undefined,
            });
            await get().reload();
            if (get().plugins[dr.dir_name]) {
              installedDeps.push(dr.dir_name);
              progressed = true;
            }
          } catch {
            // 설치 실패 — 다음 점검에서 여전히 missing 으로 잡혀 unresolved 보고됨.
          }
        }
        if (!progressed) break; // 더 진전 없으면 종료(미해결은 아래 보고)
      }
      const unresolved = allMissingDeps(pluginDepNodes(get().plugins)).map((m) => m.id);
      return ok({
        id: r.dir_name,
        dir: r.dir,
        ...(installedDeps.length ? { installedDeps } : {}),
        ...(unresolved.length ? { unresolvedDeps: unresolved } : {}),
      });
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

    remove: async (id, opts) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      // 의존자(전이) 점검 — 이 플러그인이 사라지면 고아가 될 것들. cascade 동의 없이는 차단(고아 방지).
      const nodes = pluginDepNodes(get().plugins);
      const dependents = transitiveDependents(id, nodes);
      if (dependents.length > 0 && !opts?.cascade) {
        return err(
          "CASCADE_REQUIRED",
          `"${id}" 삭제 시 의존자도 함께 삭제됩니다: ${dependents.join(", ")}. ` +
            `cascade:true 로 동의하거나, 의존자를 먼저 제거하세요.`,
        );
      }
      // 삭제 순서 — 먼(잎) 의존자부터, 대상은 마지막. dev 가 섞여도 안전(removeSingle 이 분기).
      const order = opts?.cascade ? cascadeRemovalSet(id, nodes) : [id];
      const removed: string[] = [];
      let sawInstalled = false;
      for (const rid of order) {
        const wasDev = get().plugins[rid]?.source === "dev";
        const res = await removeSingle(rid);
        if (!res.ok) return res; // 부분 진행 — 발생 사유 구조화 반환(침묵 금지)
        removed.push(rid);
        if (!wasDev) sawInstalled = true;
      }
      // 디스크 삭제(installed)가 있었으면 1회 재스캔. dev-only 면 메모리 정리로 충분(reload 가 dev 보존).
      if (sawInstalled) await get().reload();
      return ok({ id, removed });
    },

    enable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      // 템플릿(읽기 전용)은 활성화 대상이 아니다 — UI 가 토글을 숨기지만 명령
      // 경로(sok/MCP)도 막는다(단일 게이트).
      if (p.manifest.template) {
        return err("INVALID_PARAMS", `템플릿 플러그인은 활성화 대상이 아님: ${id}`);
      }
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
      // 프로그램 ensure(§2.6)는 활성화 시점에 처리 — 동의 화면에서 설치 명령을
      // 고지받고 활성화한 지금이 설치의 자리다(실행 시점은 command 그대로 깨끗).
      // 명시적 enable 에서만 — 앱 시작/reload 의 자동 재활성화는 조용히.
      void ensureProgramBinaries(p.manifest);
      // 라이브러리 종속성(libraries) 강제 설치 — 전이 deps 포함(core 의 에이전트 CLI 등).
      void ensureLibraries(p.manifest, get().plugins);
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
