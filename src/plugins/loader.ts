// 플러그인 로더 — 모듈 적재(Blob import)와 생명주기를 분리. 엔트리는 창-realm 에서 평가된다(v1).
//   - importPluginModule: 외부 코드 문자열 → ESM 모듈. blob URL 은 매번 새로워
//     ESM 캐시 문제가 없다(reload 공짜). jsdom 은 blob ESM 을 실행 못 하므로
//     이 함수만 실제 환경 검증 대상이고, 생명주기는 모듈 주입으로 전수 테스트한다.
//   - activatePlugin: 검증된 매니페스트 + 모듈 → 활성 인스턴스. 모든 등록은
//     tracker 가 자동 수거 — 비활성화 시 누수 불가(§0-4).
//   - 엔트리 모듈 양형 수용: 레거시({activate,deactivate})와 SDK 정적({controller,commands,views}).
//     정적 형태의 등록도 동일 게이트(gateContribution declared-only)와 tracker 를 통과한다.
//     레거시 수용은 전 1st-party 유닛 발행본이 정적 형태가 된 시점에 제거한다(코리도 종료 게이트).

import {
  buildPluginApi,
  type Disposable,
  type PluginApiDeps,
  type PluginContext,
} from "./api";
import { useProgramRegistry } from "./programRegistry";
import {
  C2_ENFORCEMENT,
  C3_ENFORCEMENT,
  implementsViolations,
  missingRegistrations,
  partitionEnforcement,
  partitionTransparency,
  transparencyViolations,
  type EnforcementMode,
  type ImplementsRule,
  type TransparencyMode,
  type TransparencyRule,
} from "./conformance";
import { rawImplements } from "./contractDiscovery";
import {
  registerBusBridge,
  registerServiceProxies,
  type ServiceProxyDeps,
} from "./serviceProxy";
import { busOn } from "./bus";
import { useSettings } from "../state/settings";
import type { PluginManifest } from "./spec";

// 프록시 합성에 필요한 최소 deps — PluginApiDeps 의 부분집합 + 로케일(라벨 폴백 해소).
function serviceProxyDeps(deps: PluginApiDeps): ServiceProxyDeps {
  return {
    invoke: deps.invoke,
    registerCommand: deps.registerCommand,
    unregisterCommand: deps.unregisterCommand,
    locale: () => useSettings.getState().language,
  };
}

// 서비스 프록시 + bus 브리지를 함께 건다(PS11·PS15). 수명 = 활성 수명(tracker 수거).
function wireService(manifest: PluginManifest, deps: PluginApiDeps, tracker: { wrap: (d: () => void) => void }, markRegistered: (bare: string) => void): void {
  tracker.wrap(registerServiceProxies(manifest, serviceProxyDeps(deps), markRegistered));
  if (manifest.service) {
    tracker.wrap(registerBusBridge(manifest, { invoke: deps.invoke, busOn }));
  }
}

// entry 코드 문자열 → ESM 모듈. 상대 import 불가(스펙: 단일 번들 필수).
export async function importPluginModule(code: string): Promise<unknown> {
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface EntryFns {
  activate: (ctx: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

// SDK 정적 모듈 계약(@soksak-ai/plugin-api SoksakPluginModule)의 provider 형태.
interface StaticViewProvider {
  mount(context: unknown): void | Promise<void>;
  update?(context: unknown): void | Promise<void>;
  unmount?(context: unknown): void | Promise<void>;
}
interface StaticModule {
  controller?: {
    activate?: (ctx: PluginContext) => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
  };
  commands?: Record<
    string,
    (params: Record<string, unknown>, context: unknown) => unknown
  >;
  views?: Record<string, StaticViewProvider>;
}

// 정적 view provider(새 mount({root,...}) 시그니처) → viewRegistry provider(구 mount(el,ctx)) 어댑터.
// 인스턴스별 AbortSignal 로 teardown 을 알린다. root=DOM 루트, projectRoot=프로젝트 경로(구 ctx.root 개명),
// 나머지 PluginViewContext 필드(restore·paneId·setBadge…)는 그대로 흐른다 — B3 복원 seam 보존.
function adaptStaticView(
  provider: StaticViewProvider,
  appOf: () => PluginContext["app"],
) {
  const aborts = new Map<HTMLElement, AbortController>();
  const staticCtx = (
    el: HTMLElement,
    vctx: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) => ({
    ...(vctx ?? {}),
    root: el,
    projectRoot: (vctx?.root as string | null | undefined) ?? null,
    app: appOf(),
    signal,
  });
  return {
    mount(el: HTMLElement, vctx: unknown) {
      aborts.get(el)?.abort();
      const ac = new AbortController();
      aborts.set(el, ac);
      void provider.mount(
        staticCtx(el, vctx as Record<string, unknown>, ac.signal),
      );
    },
    update: provider.update
      ? (el: HTMLElement, vctx: unknown) => {
          const ac = aborts.get(el);
          void provider.update!(
            staticCtx(
              el,
              vctx as Record<string, unknown>,
              (ac ?? new AbortController()).signal,
            ),
          );
        }
      : undefined,
    unmount(el: HTMLElement) {
      const ac = aborts.get(el);
      ac?.abort();
      aborts.delete(el);
      void provider.unmount?.({
        root: el,
        app: appOf(),
        signal: ac?.signal,
      });
    },
  };
}

// 정적 모듈 → EntryFns 합성. 등록은 전부 기존 api 게이트(gateContribution declared-only)를 통과하고
// tracker 가 수거한다 — 정적 형태라고 검증·수명 규칙이 달라지지 않는다.
function staticEntry(mod: StaticModule): EntryFns {
  return {
    activate: async (ctx) => {
      for (const [id, provider] of Object.entries(mod.views ?? {})) {
        if (!ctx.app.ui) {
          throw new Error(`정적 views 는 "ui" 권한이 필요합니다: ${id}`);
        }
        ctx.app.ui.registerView(id, adaptStaticView(provider, () => ctx.app));
      }
      for (const [name, handler] of Object.entries(mod.commands ?? {})) {
        if (!ctx.app.commands) {
          throw new Error(`정적 commands 는 "commands" 권한이 필요합니다: ${name}`);
        }
        // 표시 스펙(title·danger)은 매니페스트가 권위(PS3) — 여기는 핸들러 바인딩만.
        const decl = ctx.manifest.contributes.commands.find(
          (c) => c.name === name,
        );
        const title = decl?.title;
        const description =
          typeof title === "string"
            ? title
            : (title?.en ?? (title ? Object.values(title)[0] : name));
        ctx.app.commands.register(name, {
          description: description ?? name,
          // 정적 형태는 params 스펙 산문이 플러그인 쪽(핸들러)에 있다 — 레지스트리 validate 를
          // 건너뛰지 않으면 스펙 미선언 파라미터가 전부 INVALID_PARAMS 로 죽는다.
          paramsAuthority: "handler",
          // 표준 답변(MESSAGE-PROTOCOL §3): 정적 핸들러는 봉투에 message 를 싣는다 — data 로
          // 흘러온 그 문장을 답으로 쓰고, 없으면 매니페스트 title 로 열화한다.
          message: (d) =>
            typeof (d as { message?: unknown }).message === "string"
              ? (d as { message: string }).message
              : (description ?? name),
          handler: async (params, cctx) =>
            (await handler(params, {
              app: ctx.app,
              invocation: {
                origin: (cctx as { origin?: unknown } | undefined)?.origin,
                parent: (cctx as { parent?: unknown } | undefined)?.parent,
                execute: (cctx as { execute?: unknown } | undefined)?.execute,
              },
            })) as object,
        });
      }
      await mod.controller?.activate?.(ctx);
    },
    deactivate: async () => {
      await mod.controller?.deactivate?.();
    },
  };
}

// entry 모듈 형태 해석: default export 객체 우선, named export 폴백.
// 레거시({activate}) 우선, 정적({controller|commands|views}) 폴백 — 양형 수용(코리도).
function resolveEntry(module: unknown): EntryFns | null {
  const candidates: unknown[] = [];
  if (module && typeof module === "object") {
    candidates.push((module as { default?: unknown }).default, module);
  }
  for (const c of candidates) {
    if (
      c &&
      typeof c === "object" &&
      typeof (c as { activate?: unknown }).activate === "function"
    ) {
      const obj = c as {
        activate: EntryFns["activate"];
        deactivate?: EntryFns["deactivate"];
      };
      return {
        activate: obj.activate,
        deactivate:
          typeof obj.deactivate === "function" ? obj.deactivate : undefined,
      };
    }
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const mod = c as StaticModule;
    const hasStatic =
      (mod.controller && typeof mod.controller === "object") ||
      (mod.commands && typeof mod.commands === "object") ||
      (mod.views && typeof mod.views === "object");
    if (hasStatic) return staticEntry(mod);
  }
  return null;
}

export interface ActivePlugin {
  manifest: PluginManifest;
  dir: string;
  deactivate: () => Promise<void>;
}

// 선언했으나 등록되지 않은 register-gated contribution 을 경고(은폐 0).
// declared≡actual 의 declared→actual 방향. 활성화는 막지 않는다(§0-4) — 진단 노출은 plugin.conformance(후속).
function reportDeclaredButNotRegistered(
  manifest: PluginManifest,
  registered: {
    commands: Set<string>;
    views: Set<string>;
    fileViewers: Set<string>;
    iconSets: Set<string>;
  },
): void {
  const c = manifest.contributes;
  const gaps = (
    [
      ["commands", c.commands.map((x) => x.name), registered.commands],
      ["views", c.views.map((x) => x.id), registered.views],
      ["fileViewers", c.fileViewers.map((x) => x.id), registered.fileViewers],
      ["iconSets", c.iconSets.map((x) => x.id), registered.iconSets],
    ] as const
  )
    .map(([kind, declared, reg]) => ({
      kind,
      missing: missingRegistrations(declared, [...reg]),
    }))
    .filter((g) => g.missing.length > 0);
  if (gaps.length > 0) {
    console.warn(
      `[plugin:${manifest.id}] declared-but-not-registered: ${gaps
        .map((g) => `${g.kind}=[${g.missing.join(",")}]`)
        .join(", ")}`,
    );
  }
}

// 결합 법칙 C2(투명성 3종) 중 매니페스트 정적 규칙(command-surface·view-nodes·content-view-status)의
// 활성화 경계 시행. 판정 단일진실 = 스펙 패키지 transparency.ts(conformance 경유 소비 — 미러 금지).
// blocking 규칙 위반 = 활성화 거부(throw), warn 규칙 위반 = 경고(은폐 0). 모드 단일진실=C2_ENFORCEMENT.
// view-status 규칙은 마운트 후에만 판정 가능(viewStatusConformance, 선언≡보고) — 시행 지점이 여기가 아니다.
export function enforceTransparency(
  manifest: PluginManifest,
  enforcement: Readonly<Record<TransparencyRule, TransparencyMode>> = C2_ENFORCEMENT,
): void {
  const violations = transparencyViolations(manifest.contributes);
  const { blocking, warn } = partitionTransparency(violations, enforcement);
  for (const v of warn) {
    console.warn(`[plugin:${manifest.id}] C2 ${v.rule}: ${v.detail}`);
  }
  if (blocking.length > 0) {
    throw new Error(
      `C2 위반(${manifest.id}): ${blocking
        .map((v) => `${v.rule} — ${v.detail}`)
        .join("; ")}`,
    );
  }
}

// 결합 법칙 C3(L2 계약-핀) implements generic 검사의 활성화 경계 시행 — C2 와 같은 결.
// blocking 규칙 위반 = 활성화 거부(throw), warn 규칙 위반 = 경고(은폐 0). 모드 단일진실=C3_ENFORCEMENT.
// 계약별 요구 표면의 검증은 계약 소유자 몫 — 여기는 선언 자체(형태·문법·중복)만 본다.
export function enforceImplements(
  manifest: PluginManifest,
  enforcement: Readonly<Record<ImplementsRule, EnforcementMode>> = C3_ENFORCEMENT,
): void {
  const violations = implementsViolations(rawImplements(manifest));
  const { blocking, warn } = partitionEnforcement(violations, enforcement);
  for (const v of warn) {
    console.warn(`[plugin:${manifest.id}] C3 ${v.rule}: ${v.detail}`);
  }
  if (blocking.length > 0) {
    throw new Error(
      `C3 위반(${manifest.id}): ${blocking
        .map((v) => `${v.rule} — ${v.detail}`)
        .join("; ")}`,
    );
  }
}

// 모듈 + 매니페스트 → 활성 인스턴스. activate 실패 시 등록분 전부 회수 후 throw.
export async function activatePlugin(
  module: unknown,
  manifest: PluginManifest,
  dir: string,
  deps: PluginApiDeps,
): Promise<ActivePlugin> {
  const entry = resolveEntry(module);
  if (!entry) {
    throw new Error("entry 모듈에 activate(ctx) 가 없음");
  }

  // [C2] 투명성 3종 — 매니페스트 정적 규칙을 등록 전에 시행(blocking 위반이면 아무것도 만들지 않는다).
  enforceTransparency(manifest);
  // [C3] L2 계약-핀 — implements 선언의 generic 검사(형태·문법·중복)를 같은 경계에서 시행.
  enforceImplements(manifest);

  const { api, tracker, registered } = buildPluginApi(manifest, dir, deps);

  // 선언적 기여 자동 적용: programs 는 데이터만으로 충분(코드 바인딩 불요) —
  // 동작 전체가 매니페스트에 있어 동의 화면이 그대로 고지한다(§0-2).
  for (const p of manifest.contributes.programs) {
    tracker.wrap(useProgramRegistry.getState().register(manifest.id, p));
  }
  // bind:"service" 커맨드 프록시 + bus 브리지(PS3·PS11·PS15, docs/PLUGIN-SERVICE.md).
  // 수명 = 활성 수명(서비스 재시작과 무관 — 재등록 금지, 레지스트리 중복-throw 유효).
  wireService(manifest, deps, tracker, (bare) => registered.commands.add(bare));

  const subscriptions: Disposable[] = [];
  const ctx: PluginContext = { app: api, manifest, dir, subscriptions };

  const disposeSubscriptions = () => {
    for (const d of subscriptions.splice(0).reverse()) {
      try {
        d.dispose();
      } catch (e) {
        console.error(`플러그인 subscription 해제 실패(${manifest.id}):`, e);
      }
    }
  };

  // 개명 데이터 ns 이관(파괴적 id 개명 후폭풍 방어) — activate 전에 옛 id 의 데이터를 새 id 로
  // 옮겨 플러그인의 데이터 접근이 그 이력을 본다. 코어가 멱등하게 처리(선언된 from→to 만).
  // 충돌(양쪽 데이터)은 loud 로그·활성화 비차단 — 플러그인은 새 ns 로 계속 동작하고, 옛 데이터를
  // 병합 못 함을 알린다(무음 아님).
  if (manifest.renamedFrom) {
    try {
      await deps.invoke("data_migrate_ns", {
        fromNs: manifest.renamedFrom,
        toNs: manifest.id,
      });
    } catch (e) {
      console.error(
        `[plugin:${manifest.id}] 개명 데이터 이관 실패(renamedFrom=${manifest.renamedFrom}): ${e}`,
      );
    }
  }

  try {
    await entry.activate(ctx);
  } catch (e) {
    disposeSubscriptions();
    tracker.disposeAll();
    throw new Error(`activate 실패(${manifest.id}): ${e}`);
  }

  // [conformance] activate 후 inventory — declared≡actual 의 declared→actual 방향.
  reportDeclaredButNotRegistered(manifest, registered);

  let deactivated = false;
  return {
    manifest,
    dir,
    deactivate: async () => {
      if (deactivated) return; // 멱등
      deactivated = true;
      try {
        await entry.deactivate?.();
      } catch (e) {
        // §0-4: 플러그인의 정리 실패도 호스트 정리를 막지 못한다.
        console.error(`deactivate 실패(${manifest.id}):`, e);
      }
      disposeSubscriptions();
      tracker.disposeAll();
    },
  };
}

// 순수 계약 플러그인 활성화(PS4 — entry: null). 코드 적재 없이 게이트+데이터 기여+서비스
// 프록시만으로 활성 인스턴스를 만든다. 합법 조건(전 커맨드 bind:"service"·코드-필요 기여 0)은
// parseManifest 가 이미 강제했다 — 여기서는 재판정하지 않는다(단일 심판).
export async function activateContractPlugin(
  manifest: PluginManifest,
  dir: string,
  deps: PluginApiDeps,
): Promise<ActivePlugin> {
  // [C2]/[C3] — entry 유무와 무관하게 같은 경계에서 시행(투명성 게이트 불변 적용, PS4).
  enforceTransparency(manifest);
  enforceImplements(manifest);

  const { tracker, registered } = buildPluginApi(manifest, dir, deps);
  for (const p of manifest.contributes.programs) {
    tracker.wrap(useProgramRegistry.getState().register(manifest.id, p));
  }
  wireService(manifest, deps, tracker, (bare) => registered.commands.add(bare));
  reportDeclaredButNotRegistered(manifest, registered);

  let deactivated = false;
  return {
    manifest,
    dir,
    deactivate: async () => {
      if (deactivated) return; // 멱등
      deactivated = true;
      tracker.disposeAll();
    },
  };
}

// ── 활성 인스턴스 보관(비직렬화 객체 — store 밖) ─────────────────────────────

const active = new Map<string, ActivePlugin>();

export function isActive(id: string): boolean {
  return active.has(id);
}

export function setActive(id: string, instance: ActivePlugin): void {
  active.set(id, instance);
}

export async function deactivateById(id: string): Promise<boolean> {
  const instance = active.get(id);
  if (!instance) return false;
  active.delete(id);
  await instance.deactivate();
  return true;
}

export async function deactivateAll(): Promise<void> {
  const ids = [...active.keys()];
  for (const id of ids) {
    await deactivateById(id);
  }
}
