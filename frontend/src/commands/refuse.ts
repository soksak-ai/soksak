import type { MsgKey } from "../i18n";

// The shape a command refuses with **because of its target** — shared by every catalog.
//
// Re-spelling it per catalog makes several copies of one fact, and one day only one of them gets fixed
// (measured 2026-08-02: catalog.ts and catalogPlugins.ts each held a character-identical copy).
//
// Do not confuse this with `unknownCommand` in the registry: that one means the **command name** is
// unrecognized; this one means the command is recognized but **its target** is absent. Under one name
// the caller cannot separate "I made a typo" from "there is no such tab".

// A refusal holds its key, not a finished sentence.
//
// A handler runs before the reader of the answer is known: the same refusal goes to a window, to a
// sok caller and to a log line. Rendering here picks a language before the caller is in hand, and
// measured 2026-08-16 that answered TARGET_NOT_FOUND with a Korean sentence to an English caller.
// The registry renders it at the edge, where the reader has been stamped onto the call. This is
// the same rule the Go side keeps (docs/tech/I18N.md I4).
export const notFound = (key: MsgKey, params?: Record<string, string | number>) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  messageKey: key,
  ...(params ? { messageParams: params } : {}),
});
