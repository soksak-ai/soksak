// A command the window answers and the backend does not know about does not exist.
//
// The declaration is sent once, at the end of boot. Measured 2026-08-16: a plugin enabled after
// that registered its command, plugin.conformance counted it, state.commands listed it — and the
// socket refused it as not registered. §3.5 has one registry; a window registry and a backend
// delegation that disagree are two.
//
// So the declaration follows the registry rather than the boot path, and nobody has to remember to
// send it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { onRegistryChange, register, unregister } from "./registry";

/** Runs the microtask the notifier collapses into. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const spec = {
  description: "a fixture",
  params: {},
  returns: "{}",
  message: () => "a fixture ran",
  handler: () => ({}),
};

describe("the registry says when it changed", () => {
  let seen: number;
  let stop: () => void;

  beforeEach(() => {
    seen = 0;
    stop?.();
    stop = onRegistryChange(() => { seen += 1; });
  });

  it("a registration is a change", async () => {
    register("fixture.one", spec);
    await settle();
    expect(seen).toBe(1);
    unregister("fixture.one");
  });

  it("an unregistration is a change", async () => {
    register("fixture.two", spec);
    await settle();
    seen = 0;
    unregister("fixture.two");
    await settle();
    expect(seen).toBe(1);
  });

  it("a batch of registrations is one notice", async () => {
    // A plugin registers every command it declares, and one activation must not send one
    // declaration per command — each is a whole catalogue, and the backend would rebuild its
    // delegation table as many times as the plugin has commands.
    for (const name of ["fixture.a", "fixture.b", "fixture.c"]) register(name, spec);
    await settle();
    expect(seen).toBe(1);
    for (const name of ["fixture.a", "fixture.b", "fixture.c"]) unregister(name);
  });

  it("unregistering a name that was never there is not a change", async () => {
    expect(unregister("fixture.never")).toBe(false);
    await settle();
    expect(seen).toBe(0);
  });

  it("a listener that stops hears nothing more", async () => {
    stop();
    register("fixture.four", spec);
    await settle();
    expect(seen).toBe(0);
    unregister("fixture.four");
  });

  it("one listener throwing does not silence the others", async () => {
    // The declaration and whatever else observes it are independent. A throw in one that stopped the
    // other would make the second failure depend on the first, with nothing saying so.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    let second = 0;
    const stopBad = onRegistryChange(() => { throw new Error("a listener failed"); });
    const stopGood = onRegistryChange(() => { second += 1; });
    register("fixture.five", spec);
    await settle();
    expect(second).toBe(1);
    stopBad();
    stopGood();
    unregister("fixture.five");
    quiet.mockRestore();
  });
});
