/**
 * Waits on events until a React state command has completed through the public DOM commit.
 * The MutationObserver disconnects on both the predicate and the timeout; no interval/rAF polling.
 */
export function waitForDomCommit(
  predicate: () => boolean,
  root: Node = document.documentElement,
  timeoutMs = 2_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let closed = false;
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      observer.disconnect();
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const observer = new MutationObserver(() => {
      if (predicate()) finish();
    });
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    const timeout = setTimeout(
      () => finish(new Error(`DOM commit timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Catches a commit made between observer installation and this check.
    if (predicate()) finish();
  });
}
