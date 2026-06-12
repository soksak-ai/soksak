// 고빈도 이벤트(mousemove 등)를 프레임당 1회로 합치는 스로틀.
// 성능 헌법 원칙 4(docs/PERFORMANCE.md): 연속 입력은 rAF 로 coalesce 하고,
// 제스처 종료 시 flush() 로 마지막 값을 반드시 커밋한다(리스너 제거 전에 —
// 아니면 마지막 프레임이 유실돼 스냅백한다).

export interface RafThrottled<A extends unknown[]> {
  (...args: A): void;
  /** 대기 중인 호출을 버린다(언마운트/취소 경로). */
  cancel(): void;
  /** 대기 중인 호출이 있으면 지금 즉시 실행한다(mouseup 커밋 경로). */
  flush(): void;
}

export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): RafThrottled<A> {
  let rafId = 0;
  let lastArgs: A | null = null;

  const invoke = () => {
    rafId = 0;
    if (lastArgs === null) return;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };

  const throttled = (...args: A) => {
    lastArgs = args;
    if (!rafId) rafId = requestAnimationFrame(invoke);
  };

  throttled.cancel = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastArgs = null;
  };

  throttled.flush = () => {
    if (rafId) cancelAnimationFrame(rafId);
    invoke();
  };

  return throttled;
}
