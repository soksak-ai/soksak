import type { CommandAfterReplyTask } from "./registry";

/**
 * Complete one command reply before committing side effects that can destroy its transport.
 * A failed reply deliberately leaves the host alive: the caller did not receive success and may retry.
 */
export async function completeCommandReply(
  reply: () => Promise<unknown>,
  afterReply: readonly CommandAfterReplyTask[],
  onReplyFailure: (error: unknown) => void,
): Promise<boolean> {
  try {
    await reply();
  } catch (error) {
    onReplyFailure(error);
    return false;
  }

  for (const task of afterReply) {
    try {
      await task();
    } catch (error) {
      // The result is already delivered. A post-reply failure must be visible, but cannot rewrite it.
      console.error("command post-reply task failed:", error);
    }
  }
  return true;
}
