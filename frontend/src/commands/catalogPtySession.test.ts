import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => ({ onmessage: (_message: ArrayBuffer) => {} }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  createStream: () => stream,
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { registerPtySessionCatalog } from "./catalogPtySession";
import { execute, unregister } from "./registry";

const COMMANDS = [
  "pty.session.spawn",
  "pty.session.write",
  "pty.session.read",
  "pty.session.alive",
  "pty.session.kill",
  "pty.session.list",
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) => {
    if (name === "spawn_terminal") return { id: 41 };
    return undefined;
  });
  registerPtySessionCatalog();
});

afterEach(() => {
  for (const name of COMMANDS) unregister(name);
});

describe("pty.session.read retention status", () => {
  it("reports the exact retained and removed byte counts", async () => {
    const session = "bounded-output-test";
    const spawned = await execute("pty.session.spawn", { session }, {});
    expect(spawned.ok).toBe(true);

    const receivedBytes = 300 * 1024;
    stream.onmessage(new TextEncoder().encode("x".repeat(receivedBytes)).buffer);

    const result = await execute("pty.session.read", { session }, {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        session,
        bytesSeen: receivedBytes,
        capacityBytes: 256 * 1024,
        retainedBytes: 256 * 1024,
        droppedBytes: 44 * 1024,
      },
    });
    expect((result.data as { tail: string }).tail).toHaveLength(256 * 1024);
  });
});

describe("pty.session.write byte count", () => {
  it("reports UTF-8 bytes rather than JavaScript character units", async () => {
    const session = "utf8-input-test";
    await execute("pty.session.spawn", { session }, {});

    const result = await execute("pty.session.write", { session, data: "한" }, {});

    expect(result).toMatchObject({ ok: true, data: { session, bytes: 3 } });
    expect(invoke).toHaveBeenCalledWith("write_terminal", { id: 41, data: "한" });
  });
});
