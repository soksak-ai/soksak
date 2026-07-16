// 이 앱과 대화하는 매칭 CLI 바이너리 이름(sok / sok-dev / sok-debug).
//
// 코어가 cli_for_core_build(core_build) 로 계산해 app_environment.cli 로 노출하는 단일
// 권위값이다. 규칙은 코어 home.rs 가 소유한다 — 프론트는 재유도하지 않고 그 계산값을 읽는다.
// 프론트 번들은 env-무관(같은 JS 가 세 빌드에 실린다)이라 컴파일타임에 자기 이름을 모른다.
// 그래서 부팅 때 host 에서 한 번 읽어 캐시한다.
//
// 쓰임 = "다음 명령 제안"(hint)의 프리픽스. 제안하는 명령줄은 이 앱의 소켓에 붙는 바로 그
// 바이너리로 실행돼야 한다 — dev 앱의 힌트는 sok-dev 로 실행돼야 dev 소켓에 닿는다. 프리픽스는
// 데이터가 아니라 제시자(이 앱)의 정체성이므로, hint 생산자는 명령 형태만 짓고 이 값이 붙는다.

import { invoke } from "@tauri-apps/api/core";

let cached = "sok";

// 캐시된 CLI 이름. 부팅 로드 전이나 테스트에서는 기본 sok.
export function cliName(): string {
  return cached;
}

// 부팅 1회 — host 의 계산값(app_environment.cli)을 읽어 캐시한다. 실패(부팅 전·테스트·비-Tauri)면
// 기본 sok 를 유지한다 — 힌트가 프리픽스를 잃지 않고 릴리스 이름으로 폴백한다.
export async function loadCliName(): Promise<void> {
  try {
    const env = await invoke<{ cli?: unknown }>("app_environment");
    const cli = env?.cli;
    if (typeof cli === "string" && cli) cached = cli;
  } catch {
    // 부팅 전/테스트/비-Tauri: 기본값 유지.
  }
}

// 테스트 전용 — env 별 프리픽스 검증에 캐시를 직접 세운다.
export function __setCliNameForTest(value: string): void {
  cached = value;
}
