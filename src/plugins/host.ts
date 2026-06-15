// 플러그인 호스트 초기화 — 앱 시작 시 1회(main.tsx).
// 순서: 이벤트 훅 구독 → 앱 버전 확정(minAppVersion 검사 기준) → 스캔+재활성화.

import { getVersion } from "@tauri-apps/api/app";
import { startPluginHooks } from "./hooks";
import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";

export async function initPluginHost(): Promise<void> {
  startPluginHooks();
  try {
    usePlugins.setState({ appVersion: await getVersion() });
  } catch (e) {
    // 버전 미확인이면 minAppVersion 검사를 생략(경고) — reload 쪽에서 로그.
    console.warn("앱 버전 조회 실패:", e);
  }
  try {
    await usePlugins.getState().reload();
  } catch (e) {
    console.error("플러그인 초기 로드 실패:", e);
  }
  // 설치 가능 목록 세션 1회 원격 갱신(실패해도 스냅샷으로 동작 — 막지 않음).
  void useRegistry.getState().refresh();
}
