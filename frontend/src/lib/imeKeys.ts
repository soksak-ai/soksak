// Enter handling during IME composition (Korean and others) — a composition-commit Enter (keydown
// isComposing=true, or legacy keyCode 229) means "input confirmed", not "commit command". Failing to
// ignore it commits rename/search/navigate with unconfirmed text (standard pattern across every
// browser, WebKit included).
//
// The composition signal **differs per webview engine**. Some engines do not set isComposing, some
// do not give keyCode 229 on the commit Enter, some order compositionend differently — swapping the
// framework breaks this first, and it breaks silently (unconfirmed text is just committed, no error).
// So the decision is recorded in the ledger: which framework, which signal, and what was decided must
// be in the record so that "the IME is off" is readable without inferring from source.

import { noteImeDecision } from "./imeLedger";

export function isComposingEnter(
  e: Pick<React.KeyboardEvent, "key" | "nativeEvent" | "keyCode">,
): boolean {
  if (e.key !== "Enter") return false;
  const isComposing = e.nativeEvent.isComposing === true;
  const legacy = e.keyCode === 229;
  const composing = isComposing || legacy;
  noteImeDecision({ isComposing, legacy, composing });
  return composing;
}
