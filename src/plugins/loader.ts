// 플러그인 로더 — 모듈 적재(Blob import)와 생명주기(activate/deactivate)를 분리.
//   - importPluginModule: 외부 코드 문자열 → ESM 모듈. blob URL 은 매번 새로워
//     ESM 캐시 문제가 없다(reload 공짜). jsdom 은 blob ESM 을 실행 못 하므로
//     이 함수만 실제 환경 검증 대상이고, 생명주기는 모듈 주입으로 전수 테스트한다.
//   - activatePlugin: 검증된 매니페스트 + 모듈 → 활성 인스턴스. 모든 등록은
//     tracker 가 자동 수거 — 비활성화 시 누수 불가(§0-4).

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
import type { PluginManifest } from "./spec";

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

// entry 모듈 형태 해석: default export 객체 우선, named export 폴백.
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
// view-status 규칙은 마운트 후에만 판정 가능(unreportedStatusViews) — 시행 지점이 여기가 아니다.
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
