// Waiting for a frame, in a window that may not be drawing one.
//
// The frame clock is the right thing to wait on: a layout commit lands in a frame, and a surface is
// applied for a frame. But a window the system has stopped drawing — covered by another, its
// rendering throttled — produces no animation frame at all, and a wait that yields only on one never
// runs its own deadline check. The command that awaits it then does its work and answers nothing.
//
// Measured 2026-08-17: one run in three, `workspace.region.toggle` was silent past the client's 20
// seconds while the window sat behind another. The same shape was written down on 2026-08-16 and
// bounded with a deadline that, on this path, could never be reached.
//
// So every wait for a frame has a second clock. The frame is what it waits for; the timer is what
// guarantees it ends.

/** How long a wait gives the frame clock before it goes on without one. */
export const FRAME_FALLBACK_MS = 16;

/** Resolves on the next animation frame, or after `fallbackMs` if none arrives. */
export function nextFrame(fallbackMs: number = FRAME_FALLBACK_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, fallbackMs);
  });
}
