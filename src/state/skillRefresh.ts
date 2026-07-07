// 스킬 자동 재생성 방아쇠 — 플러그인 활성 집합(=명령 표면)이 변하면, identity 홈의 매니페스트대로
// CLI 를 스폰해 SKILL.md 를 다시 쓴다(P8 쓰기-스루: 파일 가로채기 없이 파일을 소유한다).
// 폴링 없음: zustand 구독이 신호원이고, 디바운스로 리로드 폭풍을 한 번으로 접는다.
import { invoke } from "@tauri-apps/api/core";
import { usePlugins } from "./plugins";

/** 활성 집합 지문 — 활성 플러그인 id 의 정렬 결합. 표면이 같으면 지문이 같다(순수). */
export function enabledFingerprint(plugins: Record<string, { status: string }>): string {
  return Object.entries(plugins)
    .filter(([, p]) => p.status === "enabled")
    .map(([id]) => id)
    .sort()
    .join(",");
}

export function initSkillRefresh(): void {
  let last = enabledFingerprint(usePlugins.getState().plugins);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    void invoke("skill_refresh_spawn").catch(() => {
      /* 스킬 재생성 실패가 앱 동작을 막지 않는다 — 다음 변화·설치에서 다시 시도된다 */
    });
  };
  usePlugins.subscribe((s) => {
    const now = enabledFingerprint(s.plugins);
    if (now === last) return;
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, 3000); // 연쇄 활성(부팅·전체 리로드)을 한 번으로
  });
}
