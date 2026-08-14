// The shape a command refuses with **because of its target** — shared by every catalog.
//
// Re-spelling it per catalog makes several copies of one fact, and one day only one of them gets fixed
// (measured 2026-08-02: catalog.ts and catalogPlugins.ts each held a character-identical copy).
//
// Do not confuse this with `unknownCommand` in the registry: that one means the **command name** is
// unrecognized; this one means the command is recognized but **its target** is absent. Under one name
// the caller cannot separate "I made a typo" from "there is no such tab".

export const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});
