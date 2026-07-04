// 플러그인 호스트 초기화 — 앱 시작 시 1회(main.tsx).
// 순서: 이벤트 훅 구독 → 앱 버전 확정(minAppVersion 검사 기준) → 스캔+재활성화.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { startPluginHooks } from "./hooks";
import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";

export async function initPluginHost(): Promise<void> {
  startPluginHooks();
  try {
    // release 게이트(A17) — reload 의 dev/local 거부 판정이 쓰므로 로드 이전에 확정한다.
    usePlugins.setState({ release: await invoke<boolean>("app_is_release") });
  } catch (e) {
    console.warn("release 판정 조회 실패(false 유지):", e);
  }
  try {
    usePlugins.setState({ appVersion: await getVersion() });
  } catch (e) {
    // 버전 미확인이면 minAppVersion 검사를 생략(경고) — reload 쪽에서 로그.
    console.warn("앱 버전 조회 실패:", e);
  }
  // 개발 폴더 우선 로딩 — SOKSAK_DEV_PLUGINS 의 레포 소스를 먼저 dev 로 적재한 뒤
  // reload 가 동명 설치본을 가린다(소스 편집 = 앱 리로드 즉시 반영). 경로 하나가 깨져도
  // 부팅을 막지 않도록 개별 실패는 삼킨다.
  try {
    const devPaths = await invoke<string[]>("dev_plugin_paths");
    for (const path of devPaths) {
      try {
        await usePlugins.getState().devLoad(path);
      } catch (e) {
        console.warn("dev 플러그인 로드 실패:", path, e);
      }
    }
  } catch (e) {
    console.warn("dev 플러그인 경로 조회 실패:", e);
  }
  try {
    await usePlugins.getState().reload();
  } catch (e) {
    console.error("플러그인 초기 로드 실패:", e);
  }
  // 설치 가능 목록 세션 1회 원격 갱신(실패해도 스냅샷으로 동작 — 막지 않음).
  void useRegistry.getState().refresh();
}
