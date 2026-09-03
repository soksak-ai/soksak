import { tmsg } from "../i18n";
import type { PluginViewProvider } from "./viewRegistry";

/**
 * What a view needs to come back (SESSION.md S1-5).
 *
 * - `none` — reconstructed from what is already there. A file tree reads the filesystem.
 * - `view` — a record on the view, written with setRestoreState and read back as restore.state.
 *   The plugin owns the shape; the core stores it as it was given. An editor keeps the path it had
 *   open, a browser keeps the address.
 * - `session` — work that outlives the view, held by an owner answering the session commands. A
 *   terminal, because the shell is still running with nothing drawing it.
 *
 * How much work restoring is has nothing to do with which kind it is: the terminal is by far the
 * most involved and so is the only session.
 *
 * The set is closed here rather than at each reader. A fourth kind added elsewhere leaves every
 * branch on this incomplete, and a bare string type hides that.
 */
export const RESTORE_KINDS = ["none", "view", "session"] as const;

export type RestoreKind = (typeof RESTORE_KINDS)[number];

/**
 * The kind this view declared, or a refusal.
 *
 * Declared rather than worked out, because an absent record means one thing for a view that keeps
 * nothing and another for a view that failed to read what it kept — and looking does not separate
 * them. A view with no declaration is a view whose every restore is unjudgeable, so it is refused
 * at registration instead of at the first restore that goes wrong.
 */
export function restoreKindOf(provider: PluginViewProvider): RestoreKind {
  const declared = (provider as { restores?: unknown }).restores;
  if (typeof declared === "string" && (RESTORE_KINDS as readonly string[]).includes(declared)) {
    return declared as RestoreKind;
  }
  throw new Error(
    tmsg("plugin.view.restoreUndeclared", { kinds: RESTORE_KINDS.join(", ") }),
  );
}
