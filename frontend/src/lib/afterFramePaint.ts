/** Maximum wait when WebKit does not produce an animation frame. */
export const AFTER_FRAME_PAINT_LIMIT_MS = 50;

/** Resolves in a task posted by an animation-frame callback, after that frame is painted. */
export function afterFramePaint(limitMs = AFTER_FRAME_PAINT_LIMIT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    let channel: MessageChannel | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(expiry);
      channel?.port1.close();
      channel?.port2.close();
      resolve();
    };
    const expiry = window.setTimeout(finish, limitMs);
    requestAnimationFrame(() => {
      if (finished) return;
      channel = new MessageChannel();
      channel.port1.onmessage = finish;
      channel.port2.postMessage(null);
    });
  });
}
