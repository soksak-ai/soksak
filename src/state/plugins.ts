// 플러그인 스토어 — 스캔/설치/동의/활성화 상태의 단일 저장소(테마 스토어 대칭).
//   - 검증: parseManifest(스펙 단일진실) all-or-nothing — 불량은 rejected 로 노출.
//   - 동의(§0-5): 활성화 전 사람의 동의 기록 필수. 버전/권한이 바뀌면 재동의.
//   - 활성 인스턴스(모듈/Disposable — 비직렬화)는 loader 의 Map 에 보관, 여기는
//     직렬화 가능한 런타임 상태만 담는다(plugin.list 가 그대로 나르는 형태).

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";
import {
  parseManifest,
  scanHostChromeViolations,
  semverGte,
  type LibraryDep,
  type PluginManifest,
  type PluginPermission,
} from "../plugins/spec";
import {
  activateContractPlugin,
  activatePlugin,
  deactivateAll,
  deactivateById,
  importPluginModule,
  isActive,
  setActive,
} from "../plugins/loader";
import { syncServiceLedger } from "../plugins/serviceProxy";
import { resolveTerminalProgram } from "../plugins/terminalEngine";
import { defaultPluginDeps } from "../plugins/deps";
import {
  activationChain,
  cascadeRemovalSet,
  transitiveDependents,
  type DepNode,
} from "../plugins/dependencyGraph";
import { err, ok, useSessions, type CmdResult } from "./sessions";

// 설치/dev 런타임 → 의존 그래프 노드(매니페스트 dependencies 기준). 리졸버가 소비.
function pluginDepNodes(plugins: Record<string, PluginRuntime>): DepNode[] {
  return Object.values(plugins).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
}
import { installCommandFor, detectPlatform } from "../plugins/programRegistry";
import {
  reconcilePlan,
  parseProbeVersion,
  type ReachExec,
  type Observed,
} from "../plugins/runtimeDep";

export interface PluginRuntime {
  manifest: PluginManifest;
  dir: string;
  source: "installed" | "dev";
  status: "disabled" | "enabled" | "error";
  error?: string;
}

export interface UnitDevSource {
  kind: "plugin" | "sidecar" | "kit";
  id: string;
  source: string;
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
  // .soksak.json 원문 — 공식 설치 상태. 과거 version=dev|local 단일-폴더 모델은
  // development-units.json과 충돌하므로 loader가 명시적으로 거부한다.
  state: string | null;
  error: string | null;
}

function hasLegacyDevMarker(state: string | null): boolean {
  if (!state) return false;
  try {
    const v = (JSON.parse(state) as { version?: string })?.version;
    return v === "dev" || v === "local";
  } catch {
    return false;
  }
}

interface PluginsState {
  appVersion: string; // initPluginHost 가 채움("0.0.0" = 미확인)
  release: boolean; // release core identity — 앱 updater 채널 판정용. unit 개발 허용 여부와 무관.
  plugins: Record<string, PluginRuntime>;
  rejected: RejectedPlugin[];
  consents: Record<string, ConsentRecord>; // localStorage 영속
  enabledIds: string[]; // localStorage 영속 — 재시작 시 재활성화 대상
  reload: () => Promise<void>;
  // id 지정 재적재 — 그 플러그인의 매니페스트를 디스크에서 다시 읽고 신선 코드로 켠다.
  reloadOne: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  // cascade:true 면 의존자(전이)까지 함께 삭제. 미지정 + 의존자 존재 시 CASCADE_REQUIRED 로 차단.
  remove: (
    id: string,
    opts?: { cascade?: boolean },
  ) => Promise<CmdResult<{ id: string; removed?: string[] }>>;
  enable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  disable: (id: string) => Promise<CmdResult<{ id: string; status: string }>>;
  // 동의 기록 — UI(동의 모달)만 호출한다. 명령으로 노출하지 않는다(§0-5).
  grantConsent: (id: string) => boolean;
  // 동의 철회 — 권한을 줄이는 안전 작업(재동의 필요 상태로). 활성 중이면 비활성화. 명령 노출 가능.
  revokeConsent: (id: string) => Promise<CmdResult<{ id: string }>>;
  devLoad: (path: string, expectedId?: string) => Promise<CmdResult<{ id: string; dir: string }>>;
  // bind 원장 동기화(PS9) — enabled∧service 매니페스트에서 파생해 코어에 내린다(멱등).
  syncLedger: () => Promise<void>;
}

const KEY = "soksak.plugins";

type PluginsBlob = {
  consents: Record<string, ConsentRecord>;
  enabledIds: string[];
};
const EMPTY_PLUGINS: PluginsBlob = { consents: {}, enabledIds: [] };

// app.data 권위 + ls 동기캐시(coreSync) — consents/enabledIds 멀티창 일관(이전엔 ls 만이라 창 간
// stale, 재동의/재활성 혼선). 권위 도착 시 set(활성화 자체는 reload 의 reconcile 이 담당 — 기존 모델).
const pluginsSync = createCoreSync<PluginsBlob>({
  key: "plugins",
  lsKey: KEY,
  fallback: EMPTY_PLUGINS,
  apply: (v) =>
    usePlugins.setState({
      consents: v?.consents ?? {},
      enabledIds: Array.isArray(v?.enabledIds) ? v.enabledIds : [],
    }),
});
export const initPluginsPersistence = (deps: CoreStoreDeps): (() => void) =>
  pluginsSync.init(deps);

function loadPersisted(): PluginsBlob {
  const v = pluginsSync.loadSync();
  return {
    consents: v?.consents ?? {},
    enabledIds: Array.isArray(v?.enabledIds) ? v.enabledIds : [],
  };
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

// 활성화에 필요한 동의 미충족 체인 — id 와 전이 종속 중 동의가 필요한 것들을 위상순(종속 먼저)으로.
// 종속(core)이 강력한 권한(process 등)을 가지므로, UI 는 이 순서대로 동의 팝업을 연속으로 띄워 각각
// 동의받는다(반쪽 동의 금지 §0-2). dev 소스는 게이트 면제(§0-5). 이미 동의·dev 인 항목은 제외.
export function pendingConsentChain(
  id: string,
  plugins: Record<string, PluginRuntime>,
  consents: Record<string, ConsentRecord>,
): string[] {
  return activationChain(id, pluginDepNodes(plugins)).filter((cid) => {
    const p = plugins[cid];
    return p && p.source !== "dev" && !consentValid(consents[cid], p.manifest);
  });
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
      // 설치 명령은 설정된 터미널 엔진(계약 해소)에서 가시 실행한다 — 코어는 특정 엔진을 모른다.
      // 활성 터미널 엔진이 없으면 가시 실행을 건너뛰되 침묵하지 않는다(§0-3 — 콘솔 고지).
      const terminalProgram = resolveTerminalProgram();
      if (!terminalProgram) {
        console.warn(
          `활성 터미널 엔진 없음 — ${prog.ensure.bin} 설치 명령을 가시 실행하지 못함(엔진 활성 후 + 메뉴로 실행)`,
        );
        continue;
      }
      s.addViewToGroup(s.activeId, terminalProgram, undefined, {
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

// 라이브러리 종속성 reconcile — 활성화 시점에 전이 libraries 를 4-tuple 로 수렴시킨다(은폐 0, §0-4 비차단).
//   observe(binary_integrity present/partial/broken + observe.probe 로 working/version)
//   → 순수 결정(reconcilePlan: classifyHealth/accept/nextAction + reach 선택)
//   → reach(command=가시 설치 / fetch=download_verify / vendor=verify_and_link, sha256 검증).
// PARTIAL/BROKEN 은 cleanup_stale 후 reach — 어제 EEXIST 의 근본 복구. 실패는 콘솔로만(활성화는 안 막음).
// spawnInstall 은 파라미터 — useSessions 내부 강탈 금지(테스트 가능 구조, J4).
async function reconcileDependencies(
  manifest: PluginManifest,
  plugins: Record<string, PluginRuntime>,
  spawnInstall: (command: string) => void,
): Promise<void> {
  const libs = transitiveLibraries(manifest, plugins);
  const platform = detectPlatform();
  const pluginDir = plugins[manifest.id]?.dir;
  // npm 글로벌 dir 해소 — 알면 binary_integrity(present/partial/broken) 정밀 관찰, 모르면 shell_which fallback.
  let npm: { bin_dir: string; lib_dir: string } | null = null;
  try {
    npm = await invoke<{ bin_dir: string; lib_dir: string }>("npm_global_dirs");
  } catch {
    npm = null;
  }
  for (const lib of libs) {
    try {
      const observed = await observeDep(lib, npm);
      const step = reconcilePlan(lib, observed, platform);
      if (step.action === "noop" || !step.reach) continue;
      if (step.action === "cleanup-then-reach" && npm) {
        // PARTIAL/BROKEN — stale 정리 후 reach(어제 EEXIST 의 근본 복구). 화이트리스트 경로만.
        await invoke("cleanup_stale", {
          path: `${npm.bin_dir}/${lib.bin}`,
          allowedRoots: [npm.bin_dir, `${npm.lib_dir}/node_modules`],
        }).catch((e) => console.error(`cleanup 실패(${lib.bin}):`, e));
      }
      await execReach(step.reach, lib, npm, pluginDir, spawnInstall);
    } catch (e) {
      console.error(`라이브러리 reconcile 실패(${manifest.id}/${lib.bin}):`, e);
    }
  }
}

// 관찰 — npm dir 를 알면 binary_integrity(present/partial/broken), 모르면 shell_which(present)만.
// present 이고 observe.probe 가 선언되면 실제 실행(probe)으로 working/version 을 관찰한다(존재 != 작동).
// observe.probe 미선언이면 present 를 working 근사로 본다(레거시 dep — 작동 술어 없음).
async function observeDep(
  lib: LibraryDep,
  npm: { bin_dir: string; lib_dir: string } | null,
): Promise<Observed> {
  if (!npm) {
    const present = await invoke<boolean>("shell_which", { bin: lib.bin }).catch(() => false);
    if (!present || !lib.observe) {
      return { present, working: present, partial: false, broken: false };
    }
    const p = await probeDep(lib.bin, lib.observe); // 이름 → Command 가 PATH 탐색
    return { present, working: p.ok, partial: false, broken: false, version: p.version };
  }
  const it = await invoke<{ present: boolean; partial: boolean; broken: boolean }>(
    "binary_integrity",
    { binPath: `${npm.bin_dir}/${lib.bin}`, libPath: `${npm.lib_dir}/node_modules/${lib.name}` },
  );
  if (!it.present || !lib.observe) {
    return { present: it.present, working: it.present, partial: it.partial, broken: it.broken };
  }
  const p = await probeDep(`${npm.bin_dir}/${lib.bin}`, lib.observe);
  return { present: it.present, working: p.ok, partial: it.partial, broken: it.broken, version: p.version };
}

// observe.probe 실행 — probe argv[0] 은 bin(절대경로 binPath 로 치환), 나머지는 인자.
// exit 0 = working. stdout 은 순수 parseProbeVersion 이 versionRe 로 버전 추출.
async function probeDep(
  binPath: string,
  observe: NonNullable<LibraryDep["observe"]>,
): Promise<{ ok: boolean; version?: string }> {
  const args = observe.probe.slice(1);
  const r = await invoke<{ ok: boolean; stdout: string }>("probe_binary", {
    bin: binPath,
    args,
  }).catch(() => ({ ok: false, stdout: "" }));
  return { ok: r.ok, version: parseProbeVersion(r.stdout, observe.versionRe) };
}

// reach 실행 — command=가시 터미널 설치, fetch=download_verify(다운로드+sha256), vendor=verify_and_link(번들+sha256).
async function execReach(
  reach: ReachExec,
  lib: LibraryDep,
  npm: { bin_dir: string; lib_dir: string } | null,
  pluginDir: string | undefined,
  spawnInstall: (command: string) => void,
): Promise<void> {
  if (reach.kind === "command") {
    spawnInstall(`${reach.command}; echo "[soksak] ${lib.bin} 설치 종료"`);
    return;
  }
  if (!npm) {
    console.error(`npm dir 미해소 — ${lib.bin} ${reach.kind} reach 스킵`);
    return;
  }
  const dest = `${npm.bin_dir}/${lib.bin}`;
  if (reach.kind === "fetch") {
    await invoke("download_verify", { url: reach.url, dest, sha256: reach.sha256 });
  } else {
    if (!pluginDir) {
      console.error(`plugin dir 미해소 — ${lib.bin} vendor reach 스킵`);
      return;
    }
    await invoke("verify_and_link", {
      src: `${pluginDir}/${reach.vendorPath}`,
      dest,
      sha256: reach.sha256,
    });
  }
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export const usePlugins = create<PluginsState>((set, get) => {
  const persisted = loadPersisted();

  const persist = () => {
    const s = get();
    pluginsSync.save({ consents: s.consents, enabledIds: s.enabledIds });
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
    // 순수 계약 플러그인(PS4, docs/PLUGIN-SERVICE.md) — entry 없이 활성화. 코드 적재·크롬
    // 스캔 없음(코드-필요 기여 0 은 parseManifest 가 강제) — 게이트+데이터 기여+서비스 프록시.
    if (p.manifest.entry === null) {
      const instance = await activateContractPlugin(
        p.manifest,
        p.dir,
        defaultPluginDeps(get().appVersion),
      );
      setActive(p.manifest.id, instance);
      return;
    }
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
      try {
        // workspace는 사용자의 소스이므로 삭제하지 않는다. 선택만 해제해야 다음 reload에서
        // 다시 나타나지 않고, 별도 공식 설치본이 있으면 그쪽으로 복귀한다.
        await invoke("unit_dev_remove", { kind: "plugin", id });
      } catch (e) {
        return err("INTERNAL", `개발 source 선택 해제 실패: ${e}`);
      }
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
    release: false,
    plugins: {},
    rejected: [],
    consents: persisted.consents,
    enabledIds: persisted.enabledIds,

    // bind 원장 동기화(PS9, docs/PLUGIN-SERVICE.md) — 활성(enabled)이고 service 를 선언한
    // 매니페스트에서 파생해 코어에 내린다. 어느 창이 불러도 결과 동일(코어가 내용 동일이면
    // no-op). 상태 전이(reload/enable/disable/revoke) 뒤 한 번씩 — 이벤트 시점, 폴링 0.
    syncLedger: async () => {
      try {
        const manifests = Object.values(get().plugins)
          .filter((p) => p.status === "enabled" && p.manifest.service !== undefined)
          .map((p) => p.manifest);
        await syncServiceLedger(manifests, (cmd, args) => invoke(cmd, args));
      } catch (e) {
        console.error("[service] bind 원장 동기화 실패:", e);
      }
    },

    reload: async () => {
      // 전체 재시작: 활성 인스턴스 전부 내리고 다시 스캔 — 부분 상태 금지(§0-3).
      await deactivateAll();
      const entries = await invoke<PluginScanEntry[]>("plugin_scan");
      const rejected: RejectedPlugin[] = [];
      const next: Record<string, PluginRuntime> = {};

      for (const e of entries) {
        if (e.manifest == null) {
          // manifest 도 .soksak.json(설치/dev 상태)도 없는 폴더는 애초에 플러그인이 아니다 —
          // 플러그인 폴더 아래 사는 코어 도구(검증 CLI 등)나 잡폴더다. 조용히 건너뛴다(에러 아님).
          // 상태는 있는데 manifest 만 없으면 진짜 깨진 설치본이라 거부로 드러낸다(침묵 금지).
          if (e.state == null) continue;
          rejected.push({ dir: e.dir, errors: [e.error ?? "manifest 없음"] });
          continue;
        }
        if (hasLegacyDevMarker(e.state)) {
          rejected.push({
            dir: e.dir,
            errors: [
              "공식 설치 디렉터리의 legacy dev marker는 지원하지 않습니다 — workspace를 절대경로로 unit.dev.set 하십시오",
            ],
          });
          continue;
        }
        const rt = parseRuntime(e.manifest, e.dir, e.dir_name, "installed", rejected);
        if (rt) next[rt.manifest.id] = rt;
      }

      // 선언된 개발 source는 설치본과 별도이며 같은 id의 공식 설치본을 명시적으로 덮는다.
      // config가 정본이므로 앱 재시작 뒤에도 세 환경 모두 같은 방식으로 복원된다.
      const developmentUnits =
        (await invoke<UnitDevSource[]>("unit_dev_list")) ?? [];
      for (const unit of developmentUnits) {
        if (unit.kind !== "plugin") continue;
        try {
          const data = await invoke<{ content: string }>("read_text_file", {
            path: `${unit.source}/plugin.json`,
          });
          const rt = parseRuntime(
            data.content,
            unit.source,
            unit.id,
            "dev",
            rejected,
          );
          // development source가 동명 설치본을 가린다. 실패하면 공식 설치본으로 조용히
          // fallback하지 않도록 그 id의 installed 후보도 제거한다.
          if (!rt) delete next[unit.id];
          if (rt) next[rt.manifest.id] = rt;
        } catch (e2) {
          delete next[unit.id];
          rejected.push({ dir: unit.source, errors: [`dev source 읽기 실패: ${e2}`] });
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
        // 동의 게이트 — 자신뿐 아니라 전이 종속까지(종속 약관 변경 시 의존 플러그인도 재동의 대상).
        // dev 소스는 면제(§0-5 예외 — enable 과 동일 규칙).
        const pending = pendingConsentChain(id, get().plugins, get().consents);
        if (pending.length > 0) {
          setRuntime(id, {
            status: "disabled",
            error: `재동의 필요(자신 또는 종속의 버전·권한 변경): ${pending.join(", ")}`,
          });
          continue;
        }
        try {
          await activateRuntime(p);
          setRuntime(id, { status: "enabled", error: undefined });
        } catch (e) {
          setRuntime(id, {
            status: "error",
            error: e instanceof Error && e.stack ? e.stack : String(e),
          });
        }
      }
      await get().syncLedger();
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
      for (const rid of order) {
        const res = await removeSingle(rid);
        if (!res.ok) return res; // 부분 진행 — 발생 사유 구조화 반환(침묵 금지)
        removed.push(rid);
      }
      // installed 삭제와 development 선택 해제 모두 1회 재스캔한다. 후자는 별도 보존된
      // 공식 설치본으로 즉시 복귀해야 하며 workspace 자체는 삭제하지 않는다.
      await get().reload();
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
      // 동의 게이트 — 자신뿐 아니라 전이 종속까지 검사한다(종속의 강력한 권한을 사용자가 봐야 함).
      // dev 소스는 면제(§0-5 예외 — 적재 명령이 게이트). 미동의 체인이 있으면 그 목록을 반환해 UI 가
      // 종속 먼저 순서로 동의 팝업을 연속으로 띄우게 한다(반쪽 동의 금지).
      const pending = pendingConsentChain(id, get().plugins, get().consents);
      if (pending.length > 0) {
        return err(
          "CONSENT_REQUIRED",
          `활성화 동의 필요: ${pending.join(", ")} — 종속 먼저 순서로 동의가 필요합니다`,
          { pendingConsent: pending },
        );
      }
      // 종속부터 활성화(cascade) — activationChain 순서로, 미활성·동의된 것만. 종속이 먼저 준비된다.
      const chain = activationChain(id, pluginDepNodes(get().plugins));
      for (const cid of chain) {
        const cp = get().plugins[cid];
        if (!cp) continue; // 미설치 종속(설치 플로 별도) — 건너뜀
        if (cp.status === "enabled" && isActive(cid)) continue; // 이미 활성
        try {
          await activateRuntime(cp);
        } catch (e) {
          setRuntime(cid, { status: "error", error: String(e) });
          throw e; // 명령 레이어가 INTERNAL 로 변환, UI 는 status 로 표시.
        }
        setRuntime(cid, { status: "enabled", error: undefined });
        if (!get().enabledIds.includes(cid)) {
          set((s) => ({ enabledIds: [...s.enabledIds, cid] }));
        }
        // 프로그램·라이브러리 ensure(§2.6) — 활성화 시점, 동의 화면에서 고지된 명령 그대로.
        void ensureProgramBinaries(cp.manifest);
        void reconcileDependencies(cp.manifest, get().plugins, (command) => {
          const s = useSessions.getState();
          // 라이브러리 설치 명령도 설정된 터미널 엔진에서 가시 실행(계약 해소). 엔진 없으면 침묵 금지.
          const terminalProgram = resolveTerminalProgram();
          if (!terminalProgram) {
            console.warn("활성 터미널 엔진 없음 — 라이브러리 설치 명령을 가시 실행하지 못함:", command);
            return;
          }
          s.addViewToGroup(s.activeId, terminalProgram, undefined, { command });
        });
      }
      persist();
      await get().syncLedger();
      return ok({ id, status: "enabled" });
    },

    disable: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      await deactivateById(id);
      setRuntime(id, { status: "disabled", error: undefined });
      set((s) => ({ enabledIds: s.enabledIds.filter((x) => x !== id) }));
      persist();
      await get().syncLedger();
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

    // 동의 철회 — 동의 기록 제거(재동의 필요 상태로). 활성 중이면 비활성화하고, 이 플러그인을 종속으로
    // 쓰는 의존자도 비활성화한다(종속이 미동의면 의존자도 떠선 안 됨 — 전이 일관). 권한 축소라 안전.
    revokeConsent: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      // 자신 + 전이 의존자(먼 것부터)를 비활성화 — 종속의 동의가 사라지면 의존자도 재동의 흐름으로.
      const affected = [...transitiveDependents(id, pluginDepNodes(get().plugins)), id];
      for (const aid of affected) {
        if (isActive(aid)) await deactivateById(aid);
        setRuntime(aid, { status: "disabled", error: undefined });
      }
      set((s) => {
        const consents = { ...s.consents };
        delete consents[id];
        return {
          consents,
          enabledIds: s.enabledIds.filter((x) => !affected.includes(x)),
        };
      });
      persist();
      await get().syncLedger();
      return ok({ id });
    },

    // 한 플러그인만 재적재 — 매니페스트를 **디스크에서 다시 읽는다**. 캐시된 선언으로 신선 코드를
    // 켜면 그 코드가 새로 등록하는 명령이 "선언되지 않은 명령" 으로 거부되고, 저자는 파일이 아니라
    // 메모리를 의심하게 된다(실측). 파일이 불량이면 옛 선언으로 조용히 켜지 않고 거부 이유를 답한다.
    reloadOne: async (id) => {
      const p = get().plugins[id];
      if (!p) return err("TARGET_NOT_FOUND", `플러그인 없음: ${id}`);
      let content: string;
      try {
        const data = await invoke<{ content: string }>("read_text_file", {
          path: `${p.dir}/plugin.json`,
        });
        content = data.content;
      } catch (e) {
        return err("TARGET_NOT_FOUND", `plugin.json 읽기 실패: ${e}`);
      }
      const rejected: RejectedPlugin[] = [];
      // development checkout의 폴더명은 identity가 아니다. 최초 선택·전체 reload와 동일하게
      // config가 가리킨 기존 unit id를 검증 기대값으로 사용한다.
      const expectedDirName = p.source === "dev" ? id : basename(p.dir);
      const fresh = parseRuntime(content, p.dir, expectedDirName, p.source, rejected);
      if (!fresh) {
        set({ rejected: [...get().rejected.filter((x) => x.dir !== p.dir), ...rejected] });
        return err("INVALID_PARAMS", `매니페스트 검증 실패: ${rejected[0]?.errors.join("; ")}`);
      }
      // 디스크의 id 가 바뀌었으면 그것은 다른 플러그인이다 — 이 경로로 갈아끼우지 않는다(전체 재스캔의 몫).
      if (fresh.manifest.id !== id) {
        return err(
          "INVALID_PARAMS",
          `매니페스트 id 가 바뀜(${id} → ${fresh.manifest.id}) — 전체 재적재(plugin.reload)로 처리하십시오`,
        );
      }
      set((s) => ({
        plugins: { ...s.plugins, [id]: { ...fresh, status: p.status } },
        rejected: s.rejected.filter((x) => x.dir !== p.dir),
      }));
      await get().disable(id);
      return get().enable(id);
    },

    devLoad: async (path, expectedId) => {
      let selectedPath: string;
      try {
        selectedPath =
          (await invoke<string>("unit_dev_validate_path", { source: path })) ?? path;
      } catch (e) {
        return err("INVALID_PARAMS", `개발 source 경로 거부: ${e}`);
      }
      let content: string;
      try {
        const data = await invoke<{ content: string }>("read_text_file", {
          path: `${selectedPath}/plugin.json`,
        });
        content = data.content;
      } catch (e) {
        return err("TARGET_NOT_FOUND", `plugin.json 읽기 실패: ${e}`);
      }
      const rejected: RejectedPlugin[] = [];
      // 외부 checkout의 폴더명은 unit id가 아닐 수 있다. 개발 source는 절대경로 선언이고
      // identity는 plugin.json이 소유하므로 basename을 추측 규칙으로 쓰지 않는다.
      let declaredId = "";
      try {
        const raw = JSON.parse(content) as { id?: unknown };
        if (typeof raw.id === "string") declaredId = raw.id;
      } catch {
        // parseRuntime가 동일 원문에 대한 정확한 파싱 오류를 rejected에 기록한다.
      }
      const rt = parseRuntime(content, selectedPath, declaredId, "dev", rejected);
      if (!rt) {
        return err(
          "INVALID_PARAMS",
          `매니페스트 검증 실패: ${rejected[0]?.errors.join("; ")}`,
        );
      }
      const id = rt.manifest.id;
      if (expectedId !== undefined && id !== expectedId) {
        return err(
          "INVALID_PARAMS",
          `unit id와 plugin.json id가 다릅니다: ${expectedId} != ${id}`,
        );
      }
      try {
        // 선택 상태는 매니페스트 version이나 폴더 위치가 아니라 identity 홈 config가 소유한다.
        await invoke("unit_dev_set", { kind: "plugin", id, source: selectedPath });
      } catch (e) {
        return err("INVALID_PARAMS", `개발 source 등록 실패: ${e}`);
      }
      const wasEnabled = get().enabledIds.includes(id);
      if (isActive(id)) await deactivateById(id);
      set((s) => ({ plugins: { ...s.plugins, [id]: rt } }));
      // 이전에 enabled 였다면 신선 코드로 자동 재활성화 — dev 반복(load→enable) 게이트 제거.
      // dev 소스는 동의 면제(§0-5)라 같은 동의 지위. 템플릿은 활성화 대상 아님(reload 와 동일 방어).
      // 처음 보는(enabledIds 밖) id 는 disabled 유지 — 최초 dev.load 는 현행 그대로.
      if (wasEnabled && !rt.manifest.template) {
        try {
          await activateRuntime(rt);
          setRuntime(id, { status: "enabled", error: undefined });
        } catch (e) {
          setRuntime(id, {
            status: "error",
            error: e instanceof Error && e.stack ? e.stack : String(e),
          });
        }
      }
      return ok({ id, dir: selectedPath });
    },
  };
});
