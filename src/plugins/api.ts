// 플러그인 API — activate(ctx) 로 전달되는 호스트 표면(soksak-plugin-spec v1 §0).
// 원칙:
//   - 권한은 API 표면 게이트(§0-2): 미선언 권한의 표면은 undefined.
//   - 명령은 registry 단일진실(§0-1): 등록 즉시 sok/MCP 에 자동 노출.
//   - 매니페스트가 선언의 단일진실: 선언 안 된 명령/뷰/포매터의 바인딩은 거부.
//   - 모든 등록은 내부 tracker 가 자동 수거 — 비활성화 시 누수 불가(§0-4).
//   - 의존성은 deps 로 주입(테스트 가능 구조 — 꼼수가 아니라 구조로 해결).

import type {
  CommandContext,
  CommandOutcome,
  CommandSpec,
  ParamSpec,
} from "../commands/registry";
import {
  onPluginEvent,
  type Disposable,
  type PluginEventMap,
} from "./hooks";
import {
  useViewRegistry,
  type PluginViewProvider,
} from "./viewRegistry";
import { useProgramRegistry, type ProgramSpec } from "./programRegistry";
import { useEditorRegistry } from "./editorRegistry";
import { useIconRegistry, validateIconSetData } from "../ui/icons/registry";
import type { IconSetData } from "../ui/icons/types";
import {
  pluginCommandName,
  qualifiedViewId,
  type PluginManifest,
  type PluginPermission,
  type ViewPlacement,
} from "./spec";
import type { Extension } from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as cmState from "@codemirror/state";
import * as cmLanguage from "@codemirror/language";

export type { Disposable } from "./hooks";

// ── 의존성 주입 표면 ─────────────────────────────────────────────────────────

export interface PluginApiDeps {
  appVersion: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  execute: (
    name: string,
    params: Record<string, unknown>,
    ctx: CommandContext,
  ) => Promise<CommandOutcome>;
  registerCommand: (name: string, spec: CommandSpec) => void;
  unregisterCommand: (name: string) => boolean;
  getCommandDanger: (name: string) => "destructive" | "inject" | undefined;
  on: typeof onPluginEvent;
  currentProject: () => { id: string; root: string | null } | null;
  // 활성 파일 뷰(에디터 통합 M_P7 에서 FileViewer 가 bridge 구현을 채운다).
  activeFile: () => { viewId: string; path: string; text: string } | null;
  setFileText: (viewId: string, text: string) => boolean;
}

// ── 플러그인이 보는 타입 ─────────────────────────────────────────────────────

export interface PluginCommandSpec {
  description: string;
  params?: Record<string, ParamSpec>;
  returns?: string;
  examples?: readonly string[];
  danger?: "destructive" | "inject";
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}

export interface SoksakPluginApi {
  appVersion: string;
  pluginId: string;
  commands?: {
    execute: (
      name: string,
      params?: Record<string, unknown>,
    ) => Promise<CommandOutcome>;
    register: (name: string, spec: PluginCommandSpec) => Disposable;
  };
  events: {
    on: <K extends keyof PluginEventMap>(
      event: K,
      fn: (payload: PluginEventMap[K]) => void,
    ) => Disposable;
  };
  programs?: {
    // 매니페스트 contributes.programs 의 선언 id 에 동작 spec 을 바인딩.
    register: (programId: string, spec: ProgramSpec) => Disposable;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
    openView: (
      viewId: string,
      placement?: ViewPlacement,
    ) => Promise<CommandOutcome>;
    /** 아이콘 셋 등록(contributes.iconSets 선언 필수). data 는 시맨틱 이름 전수 제공. */
    registerIconSet: (setId: string, data: unknown) => Disposable;
  };
  editor?: {
    // 호스트의 @codemirror 모듈(§0-7 — 플러그인 자체 번들 금지).
    modules: {
      view: typeof cmView;
      state: typeof cmState;
      language: typeof cmLanguage;
    };
    registerExtension: (reg: {
      extension: Extension;
      languages?: string[];
    }) => Disposable;
    // 매니페스트 contributes.formatters 의 선언 id 에 핸들러를 바인딩.
    registerFormatter: (reg: {
      id: string;
      format: (
        text: string,
        ctx: { path: string; ext: string },
      ) => string | Promise<string>;
    }) => Disposable;
    getActiveFile: () => { viewId: string; path: string; text: string } | null;
    setFileText: (viewId: string, text: string) => boolean;
  };
  storage?: {
    read: (key: string) => Promise<unknown>;
    write: (key: string, value: unknown) => Promise<void>;
    list: () => Promise<string[]>;
  };
  fs?: {
    readText?: (path: string) => Promise<{ text: string; truncated: boolean }>;
    writeText?: (path: string, content: string) => Promise<void>;
    list?: (path: string) => Promise<unknown>;
  };
  git?: {
    log: (opts?: {
      path?: string;
      limit?: number;
      skip?: number;
    }) => Promise<unknown>;
    show: (commit: string, path?: string) => Promise<unknown>;
    diff: (opts?: {
      path?: string;
      file?: string;
      commit?: string;
      staged?: boolean;
    }) => Promise<string>;
    status: (path?: string) => Promise<unknown>;
  };
  project: {
    current: () => { id: string; root: string | null } | null;
  };
}

export interface PluginContext {
  app: SoksakPluginApi;
  manifest: PluginManifest;
  dir: string;
  // 플러그인이 직접 만든 Disposable 을 넣으면 비활성화 시 자동 dispose.
  subscriptions: Disposable[];
}

// ── Disposable 수거 ──────────────────────────────────────────────────────────

export class DisposableTracker {
  private items: Disposable[] = [];

  add(d: Disposable): Disposable {
    this.items.push(d);
    return d;
  }

  wrap(dispose: () => void): Disposable {
    return this.add({ dispose });
  }

  // 역순 해제 — 개별 실패는 격리(§0-4).
  disposeAll(): void {
    const items = this.items.splice(0).reverse();
    for (const d of items) {
      try {
        d.dispose();
      } catch (e) {
        console.error("플러그인 리소스 해제 실패:", e);
      }
    }
  }
}

// ── 관리 명령 차단(§0-5 자기증식 금지) ───────────────────────────────────────
// plugin.view.* 는 뷰 열기/닫기(관리 아님)라 허용. plugin.<id>.* (플러그인 명령)도 허용.

const BLOCKED_MANAGEMENT = new Set([
  "plugin.list",
  "plugin.install",
  "plugin.update",
  "plugin.remove",
  "plugin.enable",
  "plugin.disable",
  "plugin.reload",
]);

export function isBlockedForPlugins(name: string): boolean {
  return BLOCKED_MANAGEMENT.has(name) || name.startsWith("plugin.dev.");
}

// ── API 조립 ─────────────────────────────────────────────────────────────────

const denied = (message: string): CommandOutcome => ({
  ok: false,
  code: "PERMISSION_DENIED",
  message,
});

export function buildPluginApi(
  manifest: PluginManifest,
  _dir: string,
  deps: PluginApiDeps,
): { api: SoksakPluginApi; tracker: DisposableTracker } {
  const tracker = new DisposableTracker();
  const id = manifest.id;
  const has = (p: PluginPermission) => manifest.permissions.includes(p);

  // 플러그인 호출 컨텍스트: 원격 아님(권한은 이 API 게이트가 담당 — §0-2 문서화된 모델).
  const pluginCtx: CommandContext = {};

  const executeGated = async (
    name: string,
    params?: Record<string, unknown>,
  ): Promise<CommandOutcome> => {
    if (isBlockedForPlugins(name)) {
      return denied(`플러그인은 관리 명령을 호출할 수 없음(§0-5): ${name}`);
    }
    const danger = deps.getCommandDanger(name);
    const need: PluginPermission =
      danger === "destructive"
        ? "commands:destructive"
        : danger === "inject"
          ? "commands:inject"
          : "commands";
    if (!has(need)) {
      return denied(`매니페스트 미선언 권한: ${need} (명령: ${name})`);
    }
    return deps.execute(name, params ?? {}, pluginCtx);
  };

  const api: SoksakPluginApi = {
    appVersion: deps.appVersion,
    pluginId: id,

    events: {
      on: (event, fn) => tracker.add(deps.on(event, fn)),
    },

    project: {
      current: () => deps.currentProject(),
    },

    commands: has("commands")
      ? {
          execute: executeGated,
          register: (name, spec) => {
            const declared = manifest.contributes.commands.some(
              (c) => c.name === name,
            );
            if (!declared) {
              throw new Error(
                `매니페스트 contributes.commands 에 선언되지 않은 명령: ${name}`,
              );
            }
            const full = pluginCommandName(id, name);
            deps.registerCommand(full, {
              description: spec.description,
              params: spec.params ?? {},
              returns: spec.returns ?? "object",
              examples: spec.examples,
              danger: spec.danger,
              // registry.execute 가 try/catch 로 INTERNAL 변환(§0-4).
              handler: (params) => spec.handler(params),
            });
            return tracker.wrap(() => deps.unregisterCommand(full));
          },
        }
      : undefined,

    programs: has("programs")
      ? {
          register: (programId, spec) => {
            const decl = manifest.contributes.programs.find(
              (p) => p.id === programId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.programs 에 선언되지 않은 프로그램: ${programId}`,
              );
            }
            const remove = useProgramRegistry
              .getState()
              .register(id, decl, spec);
            return tracker.wrap(remove);
          },
        }
      : undefined,

    ui: has("ui")
      ? {
          registerView: (viewId, provider) => {
            const decl = manifest.contributes.views.find(
              (v) => v.id === viewId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.views 에 선언되지 않은 뷰: ${viewId}`,
              );
            }
            const remove = useViewRegistry
              .getState()
              .register(id, decl, provider);
            return tracker.wrap(remove);
          },
          // 배치 명령(plugin.view.open — M_P5 에서 등록)으로 위임.
          openView: (viewId, placement) =>
            deps.execute(
              "plugin.view.open",
              {
                view: qualifiedViewId(id, viewId),
                ...(placement ? { placement } : {}),
              },
              pluginCtx,
            ),
          // 아이콘 셋 등록 — 선언(contributes.iconSets) 외 거부 + 데이터 전수 검증
          // (registerView 와 동일 패턴). 전역 셋 id = "<pluginId>.<setId>".
          registerIconSet: (setId, data) => {
            const decl = manifest.contributes.iconSets.find(
              (s) => s.id === setId,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.iconSets 에 선언되지 않은 셋: ${setId}`,
              );
            }
            const invalid = validateIconSetData(data);
            if (invalid) {
              throw new Error(`아이콘 셋 데이터 불량(${setId}): ${invalid}`);
            }
            const globalId = qualifiedViewId(id, setId);
            useIconRegistry.getState().register({
              id: globalId,
              name: decl.title,
              data: data as IconSetData,
            });
            return tracker.wrap(() =>
              useIconRegistry.getState().unregister(globalId),
            );
          },
        }
      : undefined,

    editor: has("editor")
      ? {
          modules: { view: cmView, state: cmState, language: cmLanguage },
          registerExtension: (reg) =>
            tracker.wrap(
              useEditorRegistry.getState().registerExtension({
                pluginId: id,
                languages: reg.languages ?? null,
                extension: reg.extension,
              }),
            ),
          registerFormatter: (reg) => {
            const decl = manifest.contributes.formatters.find(
              (f) => f.id === reg.id,
            );
            if (!decl) {
              throw new Error(
                `매니페스트 contributes.formatters 에 선언되지 않은 포매터: ${reg.id}`,
              );
            }
            return tracker.wrap(
              useEditorRegistry.getState().registerFormatter({
                pluginId: id,
                id: decl.id,
                title: decl.title,
                languages: decl.languages,
                format: reg.format,
              }),
            );
          },
          getActiveFile: () => deps.activeFile(),
          setFileText: (viewId, text) => deps.setFileText(viewId, text),
        }
      : undefined,

    storage: has("storage")
      ? {
          read: async (key) => {
            const raw = (await deps.invoke("plugin_data_read", {
              id,
              key,
            })) as string | null;
            return raw == null ? null : (JSON.parse(raw) as unknown);
          },
          write: async (key, value) => {
            await deps.invoke("plugin_data_write", {
              id,
              key,
              value: JSON.stringify(value),
            });
          },
          list: async () =>
            (await deps.invoke("plugin_data_list", { id })) as string[],
        }
      : undefined,

    fs:
      has("fs:read") || has("fs:write")
        ? {
            readText: has("fs:read")
              ? async (path) => {
                  const data = (await deps.invoke("read_text_file", {
                    path,
                  })) as { content: string; truncated: boolean };
                  return { text: data.content, truncated: data.truncated };
                }
              : undefined,
            writeText: has("fs:write")
              ? async (path, content) => {
                  await deps.invoke("write_text_file", { path, content });
                }
              : undefined,
            list: has("fs:read")
              ? (path) => deps.invoke("list_children", { path })
              : undefined,
          }
        : undefined,

    git: has("git:read")
      ? {
          log: (opts) => {
            const path = opts?.path ?? deps.currentProject()?.root;
            if (!path) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_log", {
              path,
              limit: opts?.limit,
              skip: opts?.skip,
            });
          },
          show: (commit, path) => {
            const p = path ?? deps.currentProject()?.root;
            if (!p) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_show", { path: p, commit });
          },
          diff: async (opts) => {
            const path = opts?.path ?? deps.currentProject()?.root;
            if (!path) throw new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요");
            return (await deps.invoke("git_diff", {
              path,
              file: opts?.file,
              commit: opts?.commit,
              staged: opts?.staged,
            })) as string;
          },
          status: (path) => {
            const p = path ?? deps.currentProject()?.root;
            if (!p) return Promise.reject(new Error("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요"));
            return deps.invoke("git_status", { path: p });
          },
        }
      : undefined,
  };

  return { api, tracker };
}
