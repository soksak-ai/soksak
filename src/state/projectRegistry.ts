// 프로젝트 전역 단일 오픈(P6)의 프론트 게이트 — 코어 레지스트리(project_registry.rs,
// Rust 싱글톤)가 시행의 단일 진실이고, 여기는 모든 열기/닫기 경로가 공유하는 유일한
// 통로다(단일진실 유틸 규칙: 호출부마다 claim 로직 재정의 금지).
//
// 규칙(P6): 하나의 root 는 전 창을 통틀어 최대 1곳. 충돌 시 새로 열지 않고 소유 창을
// 포커스한다. 같은 창의 재청구는 멱등(복원·재시도 안전). 창 파괴 해제는 코어가 담당.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeListen } from "../lib/safeListen";
import { currentWindowLabel } from "../lib/webviewLabels";
import { recordRecentProject } from "./recentProjects";
import { useSessions, type NewProjectOpts } from "./sessions";

interface ClaimReply {
  ok: boolean;
  ownedBy?: string;
}

/** root 점유 시도 — {ok:true} | {ok:false, ownedBy}. 실패는 예외가 아니라 값(흐름 분기용). */
export async function claimProject(root: string): Promise<ClaimReply> {
  try {
    return (await invoke<ClaimReply>("project_claim", { root })) ?? { ok: false };
  } catch (e) {
    // 레지스트리 불능(비-tauri 테스트 등)은 열기를 막지 않는다 — 시행 불가 시 기존 동작.
    console.warn("project_claim 실패(레지스트리 불능):", e);
    return { ok: true };
  }
}

/** root 점유 해제(이 창 소유일 때만 실효). 닫기 경로 공용. */
export async function releaseProject(root: string): Promise<void> {
  await invoke("project_release", { root }).catch(() => {});
}

/** P6 게이트를 지나는 프로젝트 열기 — 모든 열기 경로(커맨드·모달·부트)의 공용 진입점.
 *  다른 창 소유면 그 창을 포커스하고 { existingWindow } 로 알린다(새 창/탭 생성 없음). */
export async function addProjectClaimed(
  opts: NewProjectOpts,
): Promise<
  | { ok: true; existingWindow: string }
  | { ok: true; routedWindow: string }
  | ReturnType<ReturnType<typeof useSessions.getState>["addProject"]>
> {
  // 제어판(main = 오케스트레이터) 라우팅 — 제어판은 플러그인/프로그램을 싣지 않으므로 여기 열린
  // 프로젝트는 반쯤 죽은 워크스페이스가 된다(터미널·브라우저 없음). 제어판에서의 열기는 거부가
  // 아니라 전용 워크스페이스 창으로 라우팅한다: 이미 자기(main)가 보유 중이던 잔재는 놓아준 뒤
  // 새 창을 스폰한다. 다른 창 소유면 기존 P6 동작(그 창 포커스) 그대로.
  if (currentWindowLabel() === "main") {
    const c = await claimProject(opts.root);
    if (!c.ok && c.ownedBy && c.ownedBy !== "main") {
      await invoke("window_focus", { label: c.ownedBy }).catch(() => {});
      return { ok: true as const, existingWindow: c.ownedBy };
    }
    const held = useSessions.getState().tabs.find((t) => t.root === opts.root);
    if (held) {
      useSessions.getState().closeTab(held.id);
    }
    await releaseProject(opts.root); // 새 창 부트가 자기 이름으로 재청구한다
    const label = await invoke<string>("window_create", {
      init: `root=${encodeURIComponent(opts.root)}`,
    });
    void recordRecentProject(opts.root, opts.alias);
    return { ok: true as const, routedWindow: label };
  }
  const c = await claimProject(opts.root);
  if (!c.ok && c.ownedBy) {
    await invoke("window_focus", { label: c.ownedBy }).catch(() => {});
    return { ok: true as const, existingWindow: c.ownedBy };
  }
  const r = useSessions.getState().addProject(opts);
  if (r.ok) void recordRecentProject(opts.root, opts.alias);
  return r;
}

/** 프로젝트 닫기 + 점유 해제 — 닫기 경로(커맨드·UI 탭 닫기)의 공용 진입점.
 *  release 는 닫기 성공 시에만(마지막 프로젝트 거부 등 실패면 점유 유지가 옳다). */
export async function closeProjectReleased(projectId: string) {
  const s = useSessions.getState();
  const root = s.tabs.find((t) => t.id === projectId)?.root;
  const r = s.closeTab(projectId);
  if (r.ok && root) await releaseProject(root);
  return r;
}

/** 복원/부트 경로: 이 창 스냅샷의 root 들을 일괄 claim. 반환 = 점유 실패(다른 창 소유) root 집합
 *  — 호출부(workspaceBoot)는 해당 탭을 이 창에서 드롭한다(우아한 열화, 중복 창 금지). */
export async function claimRoots(roots: string[]): Promise<Set<string>> {
  const denied = new Set<string>();
  for (const root of roots) {
    const c = await claimProject(root);
    if (!c.ok) denied.add(root);
  }
  return denied;
}

/** 다른 창에 열린 프로젝트 목록(전역 레지스트리 뷰) — 레일이 소비해 "자기 것만 보이는" 창을
 *  없앤다: 어느 창에서든 전 프로젝트가 보이고, 클릭은 소유 창 포커스(P6 — 중복 오픈 대신 이동).
 *  반응형: project-registry-change 브로드캐스트(Rust 싱글톤 emit — 멀티창 교차상태 규칙). */
export function useOtherWindowProjects(): { root: string; window: string }[] {
  const [others, setOthers] = useState<{ root: string; window: string }[]>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const r = await invoke<{ owners: { root: string; window: string }[] }>(
          "project_owners",
        );
        if (disposed) return;
        const me = currentWindowLabel();
        setOthers(r.owners.filter((o) => o.window !== me));
      } catch {
        /* 레지스트리 불능(테스트 하니스 등) — 빈 목록 유지 */
      }
    };
    void refresh();
    const un = safeListen("project-registry-change", refresh);
    return () => {
      disposed = true;
      un();
    };
  }, []);
  return others;
}
