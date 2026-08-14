// @vitest-environment jsdom
// Two writes to one place lose one of them.
//
// Two frameworks can hold the same label (`main` is the orchestrator role, one per app, and a
// workspace window deliberately reuses a stored `w-<uuid>`). When selection is impossible, sending
// to all is correct — an earlier version rejected on overlap, and then with two apps running
// neither could be called from outside.
//
// A command whose side effect lands in **one place the caller named** is different. Measured
// 2026-08-08: two hosts performed `window.snapshot {path}`, both answered OK, and one file
// remained. The later write overwrote the earlier one and no answer stated that — work that
// answered success but left nothing is not success.
//
// So the delivery records **how many it went to** (soksak_core::control::deliver_envelope) and the
// receiving side reads that count and rejects. A written contract must be read.
import { describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => ""),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";

// The registry is module-global — re-registering per test is rejected as a duplicate.
registerCatalog();

describe("window.snapshot — with more than one host, nothing is written to a path", () => {
  it("a path with two hosts is refused by name", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, { hosts: 2 });
    expect(out.ok, "two hosts write the same path and one result is lost, yet success was answered").toBe(false);
    expect(out.code).toBe("AMBIGUOUS_HOST");
    expect(out.message).toContain("base64");
  });

  it("one host passes — a call with no overlap is not blocked", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, { hosts: 1 });
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });

  it("an unstated count is read as one — reading unknown as many would block a sound call", async () => {
    const out = await execute("window.snapshot", { path: "<local-evidence>/shot.png" }, {});
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });

  // Without a path each answer returns its own image, so there is no overlap.
  it("base64 passes with more than one host", async () => {
    const out = await execute("window.snapshot", { base64: true }, { hosts: 2 });
    expect(out.code).not.toBe("AMBIGUOUS_HOST");
  });
});
