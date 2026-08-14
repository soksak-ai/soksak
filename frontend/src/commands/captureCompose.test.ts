// Cropping and saving are separate axes — the combination must not be dropped silently.
//
// Measured 2026-07-31: given a rect, `window.snapshot` ignored `path` entirely and answered base64
// only. The caller got ok:true and there was no file — a silent ignore, with no way from outside
// to read where it went wrong. Underneath was an asymmetry of the surface: reading worked in
// base64 but writing was text only, so whatever produced a binary artifact had no way to put it
// in a file.
//
// This pins down whether the spec promises that combination. Live verification was done separately
// (rect+path 65515B, node+path 2879B); this check stops the promise from being reverted silently.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("capture — cropping and saving compose", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("the spec accepts rect, node, path, and base64", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot");
    expect(spec).toBeDefined();
    for (const key of ["rect", "node", "path", "base64"]) {
      expect(Object.keys(spec!.params)).toContain(key);
    }
  });

  it("takes a tab by name and answers the resolved target", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot")!;
    expect(Object.keys(spec.params)).toContain("tab");
    // Given a target axis, the answer states what it resolved to — the caller must be able to verify from the response alone.
    expect(spec.returns).toContain("tabId");
    // An inactive tab is parked outside the window, so this command activates it. The description
    // must state that and the promise to restore, or the caller reads the brief screen change as a defect.
    expect(spec.description).toContain("restores");
  });

  it("declares that a cropped result can also be written to a file", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const spec = reg.getSpec("window.snapshot")!;
    // Examples are what callers read — a combination missing from the examples never gets called.
    const examples = spec.examples ?? [];
    expect(examples.some((e) => e.includes("rect") && e.includes("path"))).toBe(true);
    expect(examples.some((e) => e.includes("node") && e.includes("path"))).toBe(true);
    // The old spec said rect "implies base64", which justified ignoring path. While that sentence
    // remains, the spec justifies a revert of the implementation.
    expect(spec.description).not.toContain("implies base64");
  });
});
