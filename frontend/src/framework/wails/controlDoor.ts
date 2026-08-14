// The door from outside to this window's commands.
//
// The registry already exists — this file only places it where it can be called from inside the window. A build
// with no door cannot be verified from outside, and "there was no command to call" is not a reason.
//
// When a socket is added later it goes through the same registry. Not a second registry, a second transport.

import type { CommandContext, CommandOutcome } from "../../commands/registry";

export interface ControlDoorOptions {
  scope: Record<string, unknown>;
  execute: (name: string, params: Record<string, unknown>, ctx: CommandContext) => Promise<CommandOutcome>;
  catalog: () => unknown[];
}

/**
 * Places one door in the window. Reinstalling is harmless — a reload runs boot again, so throwing on the
 * second install would turn a reload into a restart.
 */
export function installControlDoor(options: ControlDoorOptions): void {
  options.scope.soksak = {
    /**
     * Calls one command and returns the **whole envelope**.
     *
     * Returning only the payload leaves the caller unable to separate a rejection from "the result was empty".
     * code and message arrive with the value.
     */
    invoke: (name: string, params: Record<string, unknown> = {}) =>
      options.execute(name, params, { remote: false }),

    /** What exists — so the caller does not guess names. */
    commands: async () => options.catalog(),
  };
}
