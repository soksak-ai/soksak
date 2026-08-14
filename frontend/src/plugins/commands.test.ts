import { describe, expect, it } from "vitest";

import { createCommandRegistry } from "./commands";

describe("command registry", () => {
  it("invokes a registered command and returns its value", async () => {
    const commands = createCommandRegistry();
    commands.register({ name: "acme.echo", run: async (args) => args });

    await expect(commands.invoke("acme.echo", { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it("refuses an unknown command by name", async () => {
    // A registry that answers undefined lets a caller believe a command ran.
    // The name is in the rejection so the caller can tell "not yet" from "not here".
    await expect(createCommandRegistry().invoke("acme.missing")).rejects.toThrow(/acme\.missing/);
  });

  it("refuses a second owner for one name", () => {
    // Two owners of one name is a conflict, not a reload. Reload unregisters first.
    const commands = createCommandRegistry();
    commands.register({ name: "acme.echo", run: async () => null });

    expect(() => commands.register({ name: "acme.echo", run: async () => null })).toThrow(/acme\.echo/);
  });

  it("reports what it serves and what it does not, with a reason", () => {
    // A caller that receives only UNKNOWN_COMMAND cannot tell "not implemented
    // yet" from "impossible here", so it re-investigates settled ground or
    // imitates the command. The table answers for itself.
    const commands = createCommandRegistry();
    commands.register({ name: "acme.echo", owner: "plugin", run: async () => null });
    commands.declareUnserved("acme.capture", "capture is not implemented on this platform");

    expect(commands.describe()).toEqual({
      commands: [{ name: "acme.echo", owner: "plugin" }],
      unserved: [{ name: "acme.capture", blockedBy: "capture is not implemented on this platform" }],
    });
  });

  it("defaults an undeclared owner to the core", () => {
    const commands = createCommandRegistry();
    commands.register({ name: "acme.echo", run: async () => null });

    expect(commands.describe().commands).toEqual([{ name: "acme.echo", owner: "core" }]);
  });

  it("forgets a command on unregister", async () => {
    const commands = createCommandRegistry();
    commands.register({ name: "acme.echo", run: async () => null });
    commands.unregister("acme.echo");

    expect(commands.describe().commands).toEqual([]);
    await expect(commands.invoke("acme.echo")).rejects.toThrow(/acme\.echo/);
  });
});
