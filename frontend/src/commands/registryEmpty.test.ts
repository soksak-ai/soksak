// An empty registry is a different fact from "that name does not exist" — blurring them hides the cause.
//
// Measured (2026-07-31): the core commands were gone entirely, yet the response was
// `UNKNOWN_COMMAND: unknown command: ui.validate`. That sentence is word for word identical to "that
// name never existed", so from outside there was no way to read the fact that the registry was empty.
// Finding the cause took two hours, and to the user it surfaced only as the unrelated symptom "the +
// on the tab bar does not create anything".
//
// 0 has two faces: "looked and found nothing" and "the place to look is itself empty". The second is
// a defect, and a defect must answer with its own name.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("an empty registry answers with its own code", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("an empty registry answers REGISTRY_EMPTY, not UNKNOWN_COMMAND", async () => {
    const reg = await import("./registry");
    // Oracle survival — REGISTRY_EMPTY out of a filled registry would make this check meaningless.
    expect(reg.catalogJson().length).toBe(0);

    const r = await reg.execute("ui.validate", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("REGISTRY_EMPTY");
    // The human-readable text must state the fact too — changing only the code and leaving the sentence keeps the screen at odds with the fact.
    expect(r.message).toMatch(/plugin\.boot\.wait/);
  });

  it("a filled registry still answers UNKNOWN_COMMAND for an absent name", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    expect(reg.catalogJson().length).toBeGreaterThan(0);

    const r = await reg.execute("no.such.command.at.all", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
  });
});
