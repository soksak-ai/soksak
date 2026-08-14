// Single source of truth for the boot step fact payload — never drops **which window** the step is for.
//
// Measured (2026-08-01): with two windows up, one of them drew nothing. The ledger had two `painted`
// and two `boot:done` entries, but **no window was recorded**, so which one drew could not be told
// apart. There were three publish sites and only one of them put the window in — hand-built payloads
// diverge.
//
// Publishing does not happen here. Early boot has a stretch where normal invoke is unusable, so each
// call site has its own channel. This file fixes **what goes in** only.
import { currentWindowLabel } from "./webviewLabels";

/**
 * `boot.step` payload — only this function attaches step and window.
 *
 * extra holds facts specific to that step (elapsed ms, owning plugin, and so on). It cannot overwrite
 * step, window, or message: overwriting makes a field of the same name mean something different per site.
 */
export function bootFactPayload(
  step: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    step,
    window: currentWindowLabel(),
    message: `· boot ${step}`,
  };
}
