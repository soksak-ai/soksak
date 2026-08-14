// Throttle that coalesces high-frequency events (mousemove and the like) to once per frame.
// Performance constitution principle 4 (docs/PERFORMANCE.md): coalesce continuous input with rAF,
// and at gesture end always commit the last value with flush() — before removing the listener,
// otherwise the last frame is lost and the value snaps back.

export interface RafThrottled<A extends unknown[]> {
  (...args: A): void;
  /** Drop the pending call (unmount/cancel path). */
  cancel(): void;
  /** Run the pending call right now if there is one (mouseup commit path). */
  flush(): void;
}

export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): RafThrottled<A> {
  let rafId = 0;
  let task: MessageChannel | null = null;
  let scheduled = false;
  let lastArgs: A | null = null;

  const clearSchedule = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    task?.port1.close();
    task?.port2.close();
    task = null;
    scheduled = false;
  };

  const invoke = () => {
    clearSchedule();
    if (lastArgs === null) return;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };

  const throttled = (...args: A) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    // Foreground input coalesces to once per compositor frame. Backgrounded WebKit stops rAF, so
    // automation that does not steal focus cannot commit even the last value. Only in that case run
    // the same coalesce contract on the next task event. No timer, no polling, no framework branch.
    if (typeof document !== "undefined" && !document.hasFocus()) {
      task = new MessageChannel();
      task.port1.onmessage = invoke;
      task.port2.postMessage(null);
    } else {
      rafId = requestAnimationFrame(invoke);
    }
  };

  throttled.cancel = () => {
    clearSchedule();
    lastArgs = null;
  };

  throttled.flush = () => {
    clearSchedule();
    invoke();
  };

  return throttled;
}
