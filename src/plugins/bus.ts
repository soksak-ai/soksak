// 플러그인 커스텀 이벤트 버스 — 플러그인 간 임의 토픽 pub/sub(범용 coordination).
//
// 코어-정의 이벤트 토픽(hooks.ts PluginEventMap: file.saved·command.started…)과 별개로, 플러그인이
// 자기 토픽을 emit/구독한다. 예: acp-core 가 ACP session/update 를 `acp.update.<connId>` 로 스트리밍
// → 코크핏/라운지(별도 플러그인)가 구독해 라이브 렌더. 단일 커맨드 레지스트리(request/response)가
// 못 하는 **스트리밍 채널**을 메운다.
//
// 인-앱 메모리 pub/sub — 시스템 접근 0(파일·프로세스·네트워크 무관). 풀-트러스트 모델(§0-2)에서
// 플러그인 간 coordination 은 본래 가능하므로 권한 게이트 없이 모든 플러그인에 제공(범용).

type BusFn = (payload: unknown) => void;
const topics = new Map<string, Set<BusFn>>();

// 토픽 구독자에게 payload 전달. 한 리스너 오류가 다른 리스너/emit 을 막지 않는다(격리).
export function busEmit(topic: string, payload: unknown): void {
  const set = topics.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[bus] ${topic} 리스너 오류:`, e);
    }
  }
}

// 토픽 구독 → 해지 함수. (api.ts 가 tracker.wrap 으로 감싸 비활성화 시 자동 수거.)
export function busOn(topic: string, fn: BusFn): () => void {
  let set = topics.get(topic);
  if (!set) {
    set = new Set();
    topics.set(topic, set);
  }
  set.add(fn);
  return () => {
    const s = topics.get(topic);
    if (s) {
      s.delete(fn);
      if (s.size === 0) topics.delete(topic);
    }
  };
}

// 테스트용 — 전체 초기화.
export function busResetForTest(): void {
  topics.clear();
}
