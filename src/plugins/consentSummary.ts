// 동의 화면 표시 데이터의 단일 소스 — PluginConsentModal(시각)과 plugin.consent.summary(데이터/멱등
// 검증)가 같은 함수에서 파생한다. 산문 0 — 매니페스트 선언에서 기계적으로 뽑는다.
//
// 권한·기여는 매니페스트 직접값, 종속성은 플러그인↔플러그인(dependencies) + 외부 라이브러리(libraries,
// 전이 수집). 라이브러리/플러그인 deps 표기가 이 함수의 핵심(동의 화면에 종속성 표기 = 규칙).

import type { LibraryDep, LocalizedText, PluginManifest } from "./spec";
import { transitiveLibraries, type PluginRuntime } from "../state/plugins";
import { activationChain, type DepNode } from "./dependencyGraph";

// 종속 플러그인 항목 — id/range/name 에 더해 version·permissions 를 싣는다. 종속이 강력한 권한(process 등)을
// 가지므로 동의 화면이 그 권한을 보여야 한다(정직한 고지 §0-2 — 종속 동의도 사용자가 받는다, 반쪽 금지).
export interface DepPluginSummary {
  id: string;
  range?: string; // 직접 의존이면 요구 범위, 전이 의존이면 생략
  name?: LocalizedText;
  version?: string;
  permissions?: string[]; // 설치된 종속의 권한(미설치면 미상 — 설치 후 동의)
  transitive?: boolean; // 직접 의존이 아닌 전이 의존
}

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
    plugins: DepPluginSummary[];
    libraries: LibraryDep[];
  };
}

// 활성화 체인(종속 먼저, 자신 마지막)에서 자신을 제외한 종속들의 권한을 모은다. 동의 화면이 전이 종속까지
// 권한을 보이도록 — studio 동의 시 core(+그 종속)의 권한을 함께 고지하고 한 번에 동의받는다.
function dependencyConsents(
  manifest: PluginManifest,
  installed: Record<string, PluginRuntime>,
): DepPluginSummary[] {
  const nodes: DepNode[] = Object.values(installed).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: p.manifest.dependencies ?? {},
  }));
  // 자신이 아직 미설치(설치 전 preview)면 임시 노드로 추가해 체인을 풀 수 있게.
  if (!installed[manifest.id]) {
    nodes.push({
      id: manifest.id,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
    });
  }
  const directRange = manifest.dependencies ?? {};
  // 설치된 전이 종속(체인, 종속 먼저) + 미설치 직접 의존(체인은 미설치를 건너뛰므로 뒤에 보강).
  const ordered = activationChain(manifest.id, nodes).filter((id) => id !== manifest.id);
  for (const id of Object.keys(directRange)) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered.map((id) => {
    const dep = installed[id];
    const range = directRange[id];
    return {
      id,
      ...(range ? { range } : { transitive: true }),
      ...(dep
        ? {
            name: dep.manifest.name,
            version: dep.manifest.version,
            permissions: [...dep.manifest.permissions],
          }
        : {}),
    };
  });
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
      plugins: dependencyConsents(manifest, installed),
      libraries: transitiveLibraries(manifest, installed),
    },
  };
}
