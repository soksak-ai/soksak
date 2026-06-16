// 플러그인↔플러그인 의존 그래프 해소(순수 함수, I/O 0). 설치/삭제 플로가 소비한다.
// 범용 — ACP 무관(어떤 라이브러리 플러그인↔의존 플러그인). 락인 0. 멱등(재실행 안전).
//
// 두 방향:
//  - 설치: target 의 미설치 의존을 전이적으로 동반 설치(resolveMissingDeps + 호출부 fixpoint 반복).
//  - 삭제: 대상 삭제 시 고아가 될 의존자를 cascade(transitiveDependents) — 동의해야 진행, 미동의면 차단.
// refcount/versionIssues 로 그래프 무결성을 검수(모든 기능=command 로 노출).

import { semverSatisfies } from "./spec";

export interface DepNode {
  id: string;
  version: string;
  dependencies: Record<string, string>; // depId → semver 범위
}

// 직접 의존자 — id 를 자기 dependencies 에 선언한 플러그인들(설치된 것 한정).
export function directDependents(id: string, installed: DepNode[]): string[] {
  return installed.filter((n) => n.id !== id && id in (n.dependencies || {})).map((n) => n.id);
}

// 전이 의존자 — id 가 사라지면 고아가 될 모든 플러그인. 반환 순서 = 삭제 안전 순서(먼 의존자 먼저).
export function transitiveDependents(id: string, installed: DepNode[]): string[] {
  const order: string[] = []; // 가까운→먼 순서로 수집
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const dep of directDependents(cur, installed)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          order.push(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  // 삭제는 먼(잎) 의존자부터여야 안전 → 역순.
  return order.reverse();
}

// 참조수 = 직접 의존자 수. 0 이면 leaf(단순 삭제 가능).
export function refcount(id: string, installed: DepNode[]): number {
  return directDependents(id, installed).length;
}

// 삭제 cascade 집합 — [의존자(먼 것부터) …, 대상]. 이 순서대로 삭제하면 항상 의존자가 먼저 사라진다.
export function cascadeRemovalSet(id: string, installed: DepNode[]): string[] {
  return [...transitiveDependents(id, installed), id];
}

export interface MissingDep {
  id: string;
  range: string;
}

// target 의 의존 중 미설치인 것(직접). 전이 설치는 호출부가 클론→재해소 반복(fixpoint)으로 닿는다.
export function resolveMissingDeps(
  targetDeps: Record<string, string>,
  installed: DepNode[],
): MissingDep[] {
  const have = new Set(installed.map((n) => n.id));
  return Object.entries(targetDeps || {})
    .filter(([id]) => !have.has(id))
    .map(([id, range]) => ({ id, range }));
}

// 그래프 전체에서 미설치 의존(설치된 모든 플러그인의 의존 합집합, id 중복 제거). 전이 설치 루프가 소비.
export function allMissingDeps(installed: DepNode[]): MissingDep[] {
  const have = new Set(installed.map((n) => n.id));
  const seen = new Set<string>();
  const out: MissingDep[] = [];
  for (const n of installed) {
    for (const [id, range] of Object.entries(n.dependencies || {})) {
      if (!have.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ id, range });
      }
    }
  }
  return out;
}

export interface VersionIssue {
  id: string; // 의존을 선언한 플러그인
  dep: string; // 의존 대상
  range: string; // 요구 범위
  have: string | null; // 설치된 버전(없으면 null = 미설치)
  reason: "missing" | "unsatisfied" | "bad-range";
}

// 그래프 버전 무결성 — 각 의존이 설치 버전을 만족하는가. 만족하면 이슈 없음.
export function versionIssues(installed: DepNode[]): VersionIssue[] {
  const byId = new Map(installed.map((n) => [n.id, n]));
  const issues: VersionIssue[] = [];
  for (const n of installed) {
    for (const [dep, range] of Object.entries(n.dependencies || {})) {
      const have = byId.get(dep)?.version ?? null;
      if (have == null) {
        issues.push({ id: n.id, dep, range, have: null, reason: "missing" });
        continue;
      }
      const sat = semverSatisfies(have, range);
      if (sat === null) issues.push({ id: n.id, dep, range, have, reason: "bad-range" });
      else if (!sat) issues.push({ id: n.id, dep, range, have, reason: "unsatisfied" });
    }
  }
  return issues;
}

// 그래프 요약 — 한 플러그인의 의존/의존자/참조수(plugin.deps 커맨드가 반환).
export interface DepSummary {
  id: string;
  version: string;
  dependencies: Record<string, string>;
  dependents: string[]; // 직접 의존자
  refcount: number;
  cascadeOnRemove: string[]; // 이 플러그인 삭제 시 함께 삭제될 전이 의존자
}

export function depSummary(id: string, installed: DepNode[]): DepSummary | null {
  const node = installed.find((n) => n.id === id);
  if (!node) return null;
  return {
    id,
    version: node.version,
    dependencies: node.dependencies || {},
    dependents: directDependents(id, installed),
    refcount: refcount(id, installed),
    cascadeOnRemove: transitiveDependents(id, installed),
  };
}
