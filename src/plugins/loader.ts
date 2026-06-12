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
import { useEditorRegistry } from "./editorRegistry";
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
  const { api, tracker } = buildPluginApi(manifest, dir, deps);

  // 선언적 기여 자동 적용: languages 는 데이터만으로 충분(코드 바인딩 불요).
  for (const l of manifest.contributes.languages) {
    tracker.wrap(
      useEditorRegistry.getState().registerLanguage({
        pluginId: manifest.id,
        ext: l.ext,
        lang: l.lang,
      }),
    );
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
