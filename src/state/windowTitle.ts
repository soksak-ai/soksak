// 창 네이티브 타이틀 = 활성 프로젝트명 — 인앱 타이틀바는 커스텀이라 이 값을 그리지 않지만,
// Dock 창 목록·Mission Control·Cmd+` 창 전환은 NSWindow 타이틀을 보여준다. 갱신하지 않으면
// 모든 창이 conf 타이틀 하나로 보여 구분이 불가능하다(실측 — Dock 에 "soksak-dev" 3개).
// 앱 이름은 붙이지 않는다: 그 표면들은 이미 앱 아이콘/그룹 아래라 순수 중복(macOS 관례도
// 문서명만). 프로젝트 없는 창(픽커)만 앱 이름(getName — identity 별 실명)으로 폴백한다.
// 활성 프로젝트 전환·이름 변경·탭 증감마다 따라간다(sessions 구독).

import { getName } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessions } from "./sessions";

export async function initWindowTitle(): Promise<void> {
  const win = getCurrentWindow();
  const base = (await getName().catch(() => "")) || "soksak";
  let last = "";
  const apply = () => {
    const s = useSessions.getState();
    const t = s.tabs.find((x) => x.id === s.activeId);
    const next = t ? t.title : base;
    if (next === last) return; // sessions 는 고빈도 스토어 — 실변경만 IPC
    last = next;
    void win.setTitle(next).catch(() => {});
  };
  useSessions.subscribe(apply);
  apply();
}
