// 워크스페이스 영속·복원 배선(A4/A5) — sessions 스토어 ↔ coreStore(app.data) ↔ 직렬화.
//
// 키 모델(core ns):
//  - "window/<label>"  : 한 창의 워크스페이스 스냅샷(projects[] + activeId). 창 단위 원자 저장.
//  - "windows"         : window-manifest(slot → {label, roots[], activeRoot}). 재시작 복원 골격.
//
// [RULE] 레이아웃은 창-로컬(window label 키). 같은 root 를 두 창에 띄우면 각자 키라 충돌 없음 —
// 현재는 프로젝트 유니크 가드가 상위에서 막지만, 키 모델 자체는 멀티창을 이미 지원한다(A 결정).
// live status/PTY/webview 세션은 직렬화하지 않는다(workspaceSnapshot 이 제외).

import {
  serializeProject,
  deserializeProject,
  type ProjectSnapshot,
} from "./workspaceSnapshot";
import type { ProjectTab } from "./sessions";

export interface WindowSnapshot {
  activeId: string;
  projects: ProjectSnapshot[];
}

export interface ManifestEntry {
  label: string;
  roots: string[];
  activeRoot: string | null;
}

export interface WindowManifest {
  slots: ManifestEntry[];
}

// 창의 현재 sessions 상태 → 직렬화 스냅샷(창 단위).
export function snapshotWindow(
  tabs: ProjectTab[],
  activeId: string,
): WindowSnapshot {
  return { activeId, projects: tabs.map(serializeProject) };
}

// 스냅샷 → ProjectTab[] (split id 재생성은 newSplitId 주입). 복원 후 호출부가 reseed.
export function restoreWindow(
  snap: WindowSnapshot,
  newSplitId: () => string,
): { tabs: ProjectTab[]; activeId: string } {
  const tabs = snap.projects.map((p) => deserializeProject(p, newSplitId));
  const activeId = tabs.some((t) => t.id === snap.activeId)
    ? snap.activeId
    : (tabs[0]?.id ?? "");
  return { tabs, activeId };
}

// 이 창의 manifest 항목 = label + 보유 root 목록 + 활성 root.
export function windowManifestEntry(
  label: string,
  tabs: ProjectTab[],
  activeId: string,
): ManifestEntry {
  return {
    label,
    roots: tabs.map((t) => t.root),
    activeRoot: tabs.find((t) => t.id === activeId)?.root ?? null,
  };
}

// manifest 에 이 창 항목을 upsert(같은 label slot 교체, 없으면 추가). 빈 roots 면 slot 제거.
export function upsertManifest(
  manifest: WindowManifest,
  entry: ManifestEntry,
): WindowManifest {
  const others = manifest.slots.filter((s) => s.label !== entry.label);
  if (entry.roots.length === 0) return { slots: others };
  return { slots: [...others, entry] };
}
