// Commands are the only way anything reaches this application from outside.
//
// One registry serves every transport. A caller cannot tell whether it arrived
// through the frontend, a socket, or an agent, and none of them may bypass it —
// a second path drifts from the first, and the drift stays quiet until the two
// give different answers.

/** Who answers. `core` is host-independent; `framework` needs this host's window. */
export type CommandOwner = "core" | "framework" | "plugin";

export type CommandArgs = Record<string, unknown>;

export interface CommandDefinition {
  readonly name: string;
  /** Defaults to `core`. */
  readonly owner?: CommandOwner;
  run(args?: CommandArgs): Promise<unknown>;
}

export interface ServedCommand {
  readonly name: string;
  readonly owner: CommandOwner;
}

export interface UnservedCommand {
  readonly name: string;
  readonly blockedBy: string;
}

/** What this build serves and what it refuses, together. */
export interface CommandTable {
  readonly commands: ServedCommand[];
  readonly unserved: UnservedCommand[];
}

export interface CommandRegistry {
  register(command: CommandDefinition): void;
  unregister(name: string): void;
  /**
   * Record a command this build cannot serve, and why.
   *
   * A caller that receives only "unknown command" cannot separate "not written
   * yet" from "impossible here", so it re-investigates settled ground or, worse,
   * imitates the command. The reason travels with the refusal.
   */
  declareUnserved(name: string, blockedBy: string): void;
  invoke(name: string, args?: CommandArgs): Promise<unknown>;
  describe(): CommandTable;
}

export function createCommandRegistry(): CommandRegistry {
  const served = new Map<string, CommandDefinition>();
  const unserved = new Map<string, string>();

  return {
    register(command) {
      if (!command.name) throw new Error("command name is required");
      // Two owners of one name is a conflict, not a reload. Reload unregisters
      // first; silently replacing would let a later plugin capture an earlier
      // one's name and answer in its place.
      if (served.has(command.name)) throw new Error(`command ${command.name} is already registered`);
      served.set(command.name, command);
      unserved.delete(command.name);
    },
    unregister(name) {
      served.delete(name);
    },
    declareUnserved(name, blockedBy) {
      if (!blockedBy) throw new Error(`command ${name} must declare why it is unserved`);
      unserved.set(name, blockedBy);
    },
    async invoke(name, args) {
      const command = served.get(name);
      if (!command) {
        const reason = unserved.get(name);
        throw new Error(reason ? `command ${name} is not served: ${reason}` : `command ${name} is not registered`);
      }
      return command.run(args);
    },
    describe() {
      return {
        commands: [...served.values()].map((command) => ({
          name: command.name,
          owner: command.owner ?? "core",
        })),
        unserved: [...unserved.entries()].map(([name, blockedBy]) => ({ name, blockedBy })),
      };
    },
  };
}
