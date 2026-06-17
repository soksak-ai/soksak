// 동의 화면 표시 데이터의 단일 소스 — PluginConsentModal(시각)과 plugin.consent.summary(데이터/멱등
// 검증)가 같은 함수에서 파생한다. 산문 0 — 매니페스트 선언에서 기계적으로 뽑는다.
//
// 권한·기여는 매니페스트 직접값, 종속성은 플러그인↔플러그인(dependencies) + 외부 라이브러리(libraries,
// 전이 수집). 라이브러리/플러그인 deps 표기가 이 함수의 핵심(동의 화면에 종속성 표기 = 규칙).

import type { LibraryDep, LocalizedText, PluginManifest } from "./spec";
import { transitiveLibraries, type PluginRuntime } from "../state/plugins";

export interface ConsentSummary {
  id: string;
  version: string;
  permissions: string[];
  contributes: {
    views: number;
    commands: number;
    programs: number;
    formatters: number;
    languages: number;
    iconSets: number;
  };
  dependencies: {
    plugins: { id: string; range: string; name?: LocalizedText }[];
    libraries: LibraryDep[];
  };
}

export function consentSummary(
  manifest: PluginManifest,
  installed: Record<string, PluginRuntime>,
): ConsentSummary {
  const c = manifest.contributes;
  return {
    id: manifest.id,
    version: manifest.version,
    permissions: [...manifest.permissions],
    contributes: {
      views: c.views.length,
      commands: c.commands.length,
      programs: c.programs.length,
      formatters: c.formatters.length,
      languages: c.languages.length,
      iconSets: c.iconSets.length,
    },
    dependencies: {
      plugins: Object.entries(manifest.dependencies ?? {}).map(([id, range]) => ({
        id,
        range,
        ...(installed[id] ? { name: installed[id].manifest.name } : {}),
      })),
      libraries: transitiveLibraries(manifest, installed),
    },
  };
}
