// ============================================================================
// xterm-addon-webkit-ime
//
// Korean / CJK IME for xterm.js on WKWebView (Tauri, Safari) and other engines.
//
// WKWebView emits Korean IME input in TWO variants depending on whether the
// textarea's marked-text (composition) state is alive:
//
//   STANDARD  : compositionstart/update/end fire + input.inputType is
//               "insertCompositionText" / "insertFromComposition". xterm's own
//               CompositionHelper handles this — we leave it alone and read the
//               result via terminal.onData.
//
//   NON-STD   : NO compositionend; input.inputType is "insertReplacementText"
//               (and Hangul "insertText"). xterm drops these, so we intercept
//               them, buffer the syllable, draw an overlay preview at the cursor,
//               and flush the composed text on the next non-IME key.
//
// Philosophy: intercept ONLY the non-standard path; delegate the standard path
// to xterm. We also block keyCode 229 from leaking partial jamo, and shouldSkip()
// filters any jamo that still leaks through terminal.onData mid-composition.
//
// Based on xterm.js PR #5704 (minemos), adapted as an external addon.
// WebKit bug: https://bugs.webkit.org/show_bug.cgi?id=274700
//
// This file declares its own minimal structural types so it does not depend on a
// specific xterm version — works with xterm 5.x ("xterm") and 6.x ("@xterm/xterm").
//
// ── Four WKWebView composition boundary guards ──────────────────────────────
//
// Verified on a real device: Tauri 2 WKWebView, macOS, Korean 2-set Dubeolsik,
// xterm 6.0. WKWebView's event order is non-intuitive — for each composing
// keystroke the engine fires beforeinput -> input -> terminal.onData BEFORE the
// keydown(229) marker. Captured ground truth:
//
//   beforeinput(insertText "대")   ← addon can record echo expectation here
//   onData("대")                   ← xterm textarea poll echoes the char
//   input(insertText "대")         ← addon processes the composition
//   keydown(229)                   ← IME-active marker, LAST
//
// Because keydown is last, any guard that keys off _composing being set in
// keydown(229) cannot gate the very first onData of a new session.
//
//   GUARD 1 (bare-jamo skip): a single Hangul *jamo* (NOT a composed syllable)
//     arriving via terminal.onData is ALWAYS noise — a mid-composition poll
//     artifact or the first jamo of a new word after a space, where _composing
//     is still false. shouldSkip drops it unconditionally. Legitimate lone-jamo
//     (the ㅋ in "ㅋㅋㅋ") reaches the pty via _flush() -> onData, bypassing
//     shouldSkip entirely, so nothing is lost.
//
//   GUARD 2 (resyllabification echo dedup): at a syllable boundary like 읻+ㅐ
//     -> 이|대 the new syllable arrives as a full-syllable insertText. xterm
//     echoes it via onData before the previous syllable flushes, reversing the
//     order ("이대로" -> "대이로대로"). beforeinput records the single Hangul
//     char; shouldSkip drops the matching onData exactly once.
//
//   GUARD 3 (post-flush delayed-commit consumption): a terminator key (?, Enter,
//     space) flushes the pending syllable synchronously in keydown. WKWebView
//     then delivers a *delayed* composition-commit input event for the same
//     syllable AFTER the keydown — _onInput would otherwise re-buffer it,
//     producing a "가?가" tail. The flushed syllable is recorded and the
//     matching input event is consumed once. It is cleared on the next
//     keydown(229) so a legitimate same-syllable retype still delivers.
//
//   GUARD 4 (own Backspace while composing): while a syllable is pending the IME
//     consumes Backspace to shrink the composition, but xterm's keydown handler
//     ALSO synthesizes \x7f via onData — the pty then deletes the already
//     committed previous char too (two chars vanish per press). _customKey
//     returns false for keyCode 8 while _pending is non-empty so xterm never
//     synthesizes the DEL; the native textarea event still reaches the IME, so
//     deleteContentBackward shrinks the composition. shouldSkip also drops
//     \x7f / \b while pending as a belt-and-braces fallback. Once composition
//     empties the next Backspace passes through — exactly one owner at a time.
//
// The guards are one-shot / exact-match (G1-G3) or strictly _pending-scoped
// (G4): ASCII latency, multi-char pastes, and legitimate inputs (ㅋㅋㅋ, retypes,
// post-composition Backspace) are unaffected.
// ============================================================================

export interface IDisposable {
  dispose(): void;
}

/** The subset of the xterm.js Terminal API this addon uses (structural). */
export interface ITerminalLike {
  readonly textarea?: HTMLTextAreaElement;
  readonly element?: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  readonly options: { fontFamily?: string; fontSize?: number; lineHeight?: number };
  readonly buffer: { active: { readonly cursorX: number; readonly cursorY: number } };
  onRender(handler: () => void): IDisposable;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
}

/** Matches xterm's ITerminalAddon so the instance can be passed to loadAddon. */
export interface ITerminalAddon {
  activate(terminal: ITerminalLike): void;
  dispose(): void;
}

export interface WebkitImeAddonOptions {
  /** Finalized text destined for the backend (typically your pty writer). */
  onData: (data: string) => void;
  /** Optional trace hook for debugging the IME pipeline. */
  onDebug?: (msg: string) => void;
}

function isHangul(text: string): boolean {
  if (!text) return false;
  const cp = text.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xd7b0 && cp <= 0xd7ff) // Hangul Jamo Extended-B
  );
}

// True only for a single Hangul *jamo* (conjoining or compatibility), NOT for a
// fully composed syllable (U+AC00–U+D7AF). Drives GUARD 1: a bare jamo in
// terminal.onData is always noise, while composed syllables go through the
// resyllabification echo guard (GUARD 2) instead.
function isHangulJamo(text: string): boolean {
  if (!text) return false;
  const cp = text.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo (conjoining)
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xd7b0 && cp <= 0xd7ff) // Hangul Jamo Extended-B
    // U+AC00–U+D7AF (Hangul Syllables) intentionally excluded.
  );
}

export class WebkitImeAddon implements ITerminalAddon {
  private _term?: ITerminalLike;
  private _preedit?: HTMLDivElement;
  private _onRender?: IDisposable;
  private _removers: Array<() => void> = [];
  // Non-standard (insertReplacementText) composition state. The standard path
  // never sets these — it is fully owned by xterm.
  private _composing = false;
  private _pending = "";
  // GUARD 2 (resyllabification echo dedup): the single Hangul char seen on the
  // most recent IME beforeinput. shouldSkip drops the matching onData once.
  private _expectEcho = "";
  // GUARD 3 (post-flush delayed-commit): the syllable just flushed from a
  // keydown terminator. _onInput consumes the matching delayed commit once.
  private _justFlushed = "";
  // True only while _flush() runs inside _onKeydown, so the flush knows it must
  // arm GUARD 3 (a standard-path flush from _onInput must not).
  private _flushingFromKeydown = false;

  constructor(private readonly _opts: WebkitImeAddonOptions) {}

  public activate(terminal: ITerminalLike): void {
    const ta = terminal.textarea;
    if (!ta) return;
    this._term = terminal;

    const preedit = document.createElement("div");
    preedit.style.position = "absolute";
    preedit.style.pointerEvents = "none";
    preedit.style.whiteSpace = "pre";
    preedit.style.zIndex = "5";
    preedit.style.color = "#fff";
    preedit.style.background = "rgb(47, 47, 47)";
    preedit.style.textDecoration = "underline";
    preedit.style.display = "none";
    (terminal.element ?? ta.parentElement ?? document.body).appendChild(preedit);
    this._preedit = preedit;

    const add = (type: string, fn: (e: Event) => void): void => {
      ta.addEventListener(type, fn, true);
      this._removers.push(() => ta.removeEventListener(type, fn, true));
    };

    // NOTE: we do NOT touch compositionstart/update/end — leaving them lets
    // WebKit keep its marked-text state on the STANDARD path that xterm handles.
    // We only intercept the non-standard input variants.
    add("input", this._onInput as (e: Event) => void);
    add("keydown", this._onKeydown as (e: Event) => void);
    // GUARD 2: beforeinput arrives before the xterm textarea poll onData, so it
    // is the only place to record the echo expectation.
    add("beforeinput", this._onBeforeinput as (e: Event) => void);

    // Block xterm's CompositionHelper from sending partial jamo on keyCode 229.
    terminal.attachCustomKeyEventHandler(this._customKey);

    this._onRender = terminal.onRender(() => {
      if (this._composing && this._pending) this._show(this._pending);
    });
  }

  public dispose(): void {
    for (const off of this._removers) off();
    this._removers = [];
    this._onRender?.dispose();
    this._onRender = undefined;
    this._preedit?.remove();
    this._preedit = undefined;
    // Release the custom key handler so it doesn't leak into another addon.
    this._term?.attachCustomKeyEventHandler(() => true);
    this._composing = false;
    this._pending = "";
    this._expectEcho = "";
    this._justFlushed = "";
    this._flushingFromKeydown = false;
  }

  /** Call from terminal.onData — true if the data is leaked jamo to drop. */
  public shouldSkip(data: string): boolean {
    // GUARD 4 (belt-and-braces): _customKey already returns false for Backspace
    // while _pending is non-empty, so xterm should never synthesize \x7f / \b
    // during composition. But if any path still emits it (a fallback xterm
    // handler, a future xterm version, a test harness), drop it here too while a
    // syllable is pending. Tied to _pending — the moment composition empties the
    // next Backspace reaches the pty normally, so there is no one-shot state.
    if ((data === "\x7f" || data === "\b") && this._pending !== "") return true;
    // GUARD 1: a single Hangul jamo is ALWAYS noise — drop it regardless of
    // _composing. keydown(229) fires AFTER this onData, so _composing may still
    // be false for the first jamo of a post-space word; an unconditional drop is
    // the only thing that closes the inter-word leak. Legitimate lone-jamo (ㅋ)
    // reaches the pty via _flush() -> onData, never through this path.
    if (data.length === 1 && isHangulJamo(data)) return true;
    // GUARD 2: resyllabification echo. beforeinput recorded the incoming single
    // Hangul char; drop the matching onData once so the new syllable does not
    // leak ahead of the ordered flush of the previous one. Applies to jamo and
    // composed syllables; multi-char paste never matches (_expectEcho is always
    // a single char).
    if (data.length === 1 && isHangul(data) && data === this._expectEcho) {
      this._expectEcho = "";
      return true;
    }
    // Mid-composition jamo that still leaks through (original behavior).
    return this._composing && data.length === 1 && isHangul(data);
  }

  /**
   * Commit any pending non-standard syllable immediately. Call this from
   * terminal.onData BEFORE forwarding a non-skipped chunk to the pty so the
   * composed syllable is ordered ahead of the following external input.
   *
   * GUARD 7: WKWebView routes a non-Hangul key pressed mid-composition (`.`,
   * `?`, `!`, punctuation, ASCII, paste) to the pty via xterm's textarea-poll
   * onData, which fires BEFORE the addon's keydown flush — so the char landed
   * before the pending syllable ("자" + "." → ".자", "하" + "?" → "?하"). Flushing
   * here, on the same onData path that writes the char, guarantees correct order.
   * No-op when nothing is pending.
   */
  public flushPending(): void {
    this._flush();
  }

  private _customKey = (ev: KeyboardEvent): boolean => {
    if (ev.type === "keydown" && (ev.keyCode === 229 || ev.isComposing)) {
      return false; // block xterm's keydown processing for IME keys
    }
    // GUARD 5 (companion): while a syllable is pending, the terminator / control
    // keys are owned by _onKeydown, which flushes the syllable and emits the
    // control char itself. WKWebView delivers these keys with isComposing=FALSE,
    // so the check above does NOT block them — without this, xterm ALSO processes
    // the key and emits a premature control char. For Enter that means a \r is
    // sent BEFORE the pending syllable is flushed, executing the already-flushed
    // previous syllable: "한글"+Enter splits into "한"⏎ "글"⏎. Block xterm here so
    // only _onKeydown emits the terminator.
    if (ev.type === "keydown" && this._pending !== "") {
      if (ev.key === "Enter" || ev.key === "Tab" || ev.key === "Escape") {
        return false;
      }
      if (
        ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        ev.key.length === 1 &&
        ev.key >= "a" &&
        ev.key <= "z"
      ) {
        return false;
      }
    }
    // GUARD 4: while a syllable is being composed (_pending is non-empty),
    // Backspace belongs entirely to the IME. Return false so xterm never
    // synthesizes \x7f (DEL) via onData — otherwise the pty deletes the already
    // committed previous char while the IME also shrinks the pending syllable
    // (two chars vanish per press). The native textarea event still reaches
    // WebKit's IME, which fires deleteContentBackward to shrink/clear the
    // composition (handled by _onKeydown/_onInput). Once _pending is empty the
    // next Backspace must reach the pty normally, so we block only while the
    // composition has content — exactly one owner at any moment.
    if (ev.type === "keydown" && ev.keyCode === 8 && this._pending !== "") {
      return false;
    }
    return true;
  };

  private _onKeydown = (e: KeyboardEvent): void => {
    this._opts.onDebug?.(`KEY key=${JSON.stringify(e.key)} code=${e.keyCode} composing=${this._composing} isComposing=${e.isComposing}`);

    // GUARD 5: terminator / control key (Enter / Tab / Escape / Ctrl+A..Z) pressed
    // WHILE a non-standard syllable is pending. WKWebView fires these with
    // isComposing=true, so they used to fall into the IME early-return below and
    // get swallowed — the pending syllable was never flushed and the control char
    // was lost. Symptoms: "안녕하세요"+Enter sent only "안녕하세" and left "요"
    // composing (a second Enter was needed); Ctrl+C mid-composition could not
    // abort a running command. Commit the pending syllable here (arming GUARD 3
    // for any delayed commit) and emit the control char ourselves, because
    // _customKey blocks xterm from processing IME-composing keys. Gated on
    // _composing + the exact keys, so space and ordinary keys keep their existing
    // behavior. (Arrow/Home/End/PageUp during composition still swallowed — those
    // need full xterm key-sequence encoding and are left as a known limitation.)
    let emit: string | null = null;
    if (this._composing) {
      if (e.key === "Enter") emit = "\r";
      else if (e.key === "Tab") emit = "\t";
      else if (e.key === "Escape") emit = "\x1b";
      else if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key >= "a" &&
        e.key <= "z"
      ) {
        // Ctrl+A..Z -> \x01..\x1A (Ctrl+C = \x03, Ctrl+D = \x04, Ctrl+Z = \x1A).
        // Without this, an interrupt typed mid-composition is swallowed by the IME
        // early-return below and the running command cannot be aborted.
        emit = String.fromCharCode(e.key.charCodeAt(0) - 96);
      }
    }
    if (emit !== null) {
      this._flushingFromKeydown = true;
      this._flush();
      this._flushingFromKeydown = false;
      this._opts.onData(emit);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (e.keyCode === 229 || e.isComposing) {
      // Block CompositionHelper._handleAnyTextareaChanges (partial jamo leak).
      // A new IME session proves the GUARD 3 post-flush window has passed, so a
      // legitimate same-syllable retype is delivered rather than swallowed.
      this._justFlushed = "";
      e.stopImmediatePropagation();
      return;
    }

    // Non-standard composition: a plain keyCode 8 backspace means a single jamo
    // is left and the IME emits no further input — clear it ourselves.
    if (e.key === "Backspace" && this._composing) {
      this._composing = false;
      this._pending = "";
      this._hide();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // GUARD 6: a bare modifier keydown (Shift / Control / Alt / Meta / CapsLock /
    // AltGraph) does NOT end a composition — it is held to form the next jamo,
    // e.g. Shift+ㅅ → ㅆ for the double consonant in "있". Without this, the Shift
    // keydown falls into the "any other key flushes" branch below and prematurely
    // commits the pending syllable: typing "있" (이 + ㅆ) flushed "이" on the Shift
    // press, then composed "있" fresh — producing "이있" (likewise 갔→가갔,
    // 했→해했). Modifier-only keys must be ignored entirely here.
    if (
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta" ||
      e.key === "CapsLock" ||
      e.key === "AltGraph"
    ) {
      return;
    }

    // Any other key ends a non-standard composition: flush it, then let xterm
    // handle the key normally (no preventDefault) so it reaches onData. Mark the
    // flush as keydown-originated so GUARD 3 arms for the delayed commit.
    if (this._composing) {
      this._flushingFromKeydown = true;
      this._flush();
      this._flushingFromKeydown = false;
    }
  };

  private _onBeforeinput = (e: InputEvent): void => {
    this._opts.onDebug?.(
      `BEFOREINPUT type=${e.inputType} data=${JSON.stringify(e.data)} composing=${this._composing} pending=${JSON.stringify(this._pending)} expectEcho=${JSON.stringify(this._expectEcho)}`,
    );
    // GUARD 2: record the incoming single Hangul char so shouldSkip can suppress
    // the matching xterm textarea-poll onData that fires between this beforeinput
    // and the following input event. Only IME writes (insertText /
    // insertReplacementText) of exactly one Hangul code point qualify — multi-char
    // paste of Korean text must reach the pty untouched.
    if (
      e.data !== null &&
      e.data.length === 1 &&
      isHangul(e.data) &&
      (e.inputType === "insertText" || e.inputType === "insertReplacementText")
    ) {
      this._expectEcho = e.data;
    } else {
      // Clear a stale expectation on any non-qualifying beforeinput so an
      // unrelated event cannot cause a false-positive suppression later.
      this._expectEcho = "";
    }
  };

  private _onInput = (e: InputEvent): void => {
    this._opts.onDebug?.(
      `INPUT type=${e.inputType} data=${JSON.stringify(e.data)} composing=${this._composing} pending=${JSON.stringify(this._pending)}`,
    );

    // GUARD 3: WKWebView delivers a delayed composition-commit input event for a
    // syllable already flushed by a keydown terminator. Consume it silently — do
    // NOT start a new composition. WKWebView may use insertText or
    // insertReplacementText for the commit.
    if (
      e.data !== null &&
      e.data === this._justFlushed &&
      (e.inputType === "insertText" || e.inputType === "insertReplacementText")
    ) {
      this._justFlushed = "";
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    // Any non-matching input ends the post-flush window so the guard never lingers.
    if (this._justFlushed) this._justFlushed = "";

    // NON-STANDARD: composition update (ㅎ -> 하 -> 한). Intercept + preview.
    if (e.data && e.inputType === "insertReplacementText") {
      this._composing = true;
      this._pending = e.data;
      this._show(e.data);
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // NON-STANDARD: Hangul insertText starts a new composition.
    if (e.data && e.inputType === "insertText" && isHangul(e.data)) {
      if (this._composing) this._flush();
      this._composing = true;
      this._pending = e.data;
      this._show(e.data);
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // NON-STANDARD: backspace emptied the composition (deleteContentBackward or
    // empty insertReplacementText) — clear buffer + preview.
    if (
      this._composing &&
      (e.inputType === "deleteContentBackward" || (e.inputType === "insertReplacementText" && !e.data))
    ) {
      this._composing = false;
      this._pending = "";
      this._hide();
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }

    // STANDARD path (insertCompositionText / insertFromComposition / plain text):
    // do NOT intercept — xterm handles it and emits onData. If a non-standard
    // composition was somehow open, flush it first.
    if (this._composing) this._flush();
  };

  private _place(): void {
    const term = this._term;
    const preedit = this._preedit;
    if (!term || !preedit) return;
    const core = (term as unknown as { _core?: any })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const el = term.element;
    const cw = cell?.width ?? (el ? el.clientWidth / term.cols : 9);
    const ch = cell?.height ?? (el ? el.clientHeight / term.rows : 17);
    const buf = term.buffer.active;
    const col = Math.min(buf.cursorX, term.cols - 1);
    const row = buf.cursorY; // viewport-relative
    preedit.style.left = `${col * cw}px`;
    preedit.style.top = `${row * ch}px`;
    preedit.style.height = `${ch}px`;
    preedit.style.lineHeight = `${ch}px`;
    preedit.style.fontFamily = term.options.fontFamily ?? "monospace";
    preedit.style.fontSize = `${term.options.fontSize ?? 15}px`;
  }

  private _show(text: string): void {
    if (!this._preedit) return;
    this._preedit.textContent = text;
    this._place();
    this._preedit.style.display = "block";
  }

  private _hide(): void {
    if (!this._preedit) return;
    this._preedit.textContent = "";
    this._preedit.style.display = "none";
  }

  private _flush(): void {
    if (!this._composing) return;
    const text = this._pending;
    this._composing = false;
    this._pending = "";
    this._hide();
    if (text) {
      this._opts.onDebug?.(
        `FLUSH ${JSON.stringify(text)} fromKeydown=${this._flushingFromKeydown}`,
      );
      // GUARD 3: only a keydown-originated flush (a non-IME terminator key) is
      // followed by a delayed commit. A standard-path flush from _onInput is
      // already followed by correct input processing, so it must not arm.
      if (this._flushingFromKeydown) this._justFlushed = text;
      this._opts.onData(text);
    }
  }
}
