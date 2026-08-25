import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { registerSidecarCatalog } from "./catalogSidecar";
import { execute, getSpec, unregister } from "./registry";
import { createEnvironmentEventHandler, setEnvironmentEventHandler } from "../state/environmentEvents";

const REGISTERED = ["sidecar.request", "sidecar.install.local.plan", "sidecar.install.local", "sidecar.develop", "sidecar.remove"];

describe("sidecar.request", () => {
  beforeEach(() => invoke.mockReset());
  afterEach(() => { for (const name of REGISTERED) unregister(name); });

  it("relays one opaque control request without interpreting its command", async () => {
    registerSidecarCatalog();
    invoke.mockResolvedValueOnce({ ok: true, result: { data: { session: 7 } } });
    const request = { id: "inspect", command: "pty.pane", args: { request: { paneId: "pan-abc234" } } };
    const result = await execute("sidecar.request", { name: "pty", request }, {});
    expect(invoke).toHaveBeenCalledWith("sidecar_send", { name: "pty", payload: JSON.stringify(request) });
    expect(result).toMatchObject({ ok: true, data: { sidecar: "pty", response: { ok: true } } });
  });

  it("rejects an array instead of inventing a request shape", async () => {
    registerSidecarCatalog();
    const result = await execute("sidecar.request", { name: "pty", request: [] }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("sidecar.develop / sidecar.remove", () => {
  const reload = vi.fn(async () => {});
  let restore: () => void = () => {};
  beforeEach(() => {
    invoke.mockReset();
    reload.mockClear();
    restore = setEnvironmentEventHandler(createEnvironmentEventHandler(reload, 1));
    registerSidecarCatalog();
  });
  afterEach(() => {
    restore();
    for (const name of REGISTERED) unregister(name);
  });

  it("declares sidecarId and path, and is destructive because it replaces the existing record", () => {
    const spec = getSpec("sidecar.develop");
    expect(spec).toBeDefined();
    expect(spec!.params.sidecarId.required).toBe(true);
    expect(spec!.params.path.required).toBe(true);
    expect(spec!.danger).toBe("destructive");
  });

  it("declares SIDECAR_IN_USE among the codes sidecar.develop returns", () => {
    expect(getSpec("sidecar.develop")!.errors).toEqual(["INVALID_PARAMS", "SIDECAR_IN_USE", "INTERNAL"]);
  });

  it.each([
    ["open", { open: [{ name: "soksak-sidecar-pty" }], recorded: [] }],
    ["recorded", { open: [], recorded: [{ name: "soksak-sidecar-pty" }] }],
  ])("sidecar.develop refuses SIDECAR_IN_USE when sidecar_status lists the id as %s, without a host write", async (_state, status) => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return status;
      if (cmd === "environment_get") return { revision: 4 };
      if (cmd === "sidecar_develop") return { previousRevision: 4, revision: 5 };
      return null;
    });
    const result = await execute("sidecar.develop", { sidecarId: "soksak-sidecar-pty", path: "/work/pty" }, {});
    expect(result).toMatchObject({ ok: false, code: "SIDECAR_IN_USE", message: expect.stringContaining("soksak-sidecar-pty") });
    expect(invoke).not.toHaveBeenCalledWith("sidecar_develop", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("environment_get");
    expect(reload).not.toHaveBeenCalled();
  });

  it("passes a relative path to the host unchanged; the host validates the path", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return { revision: 4 };
      if (cmd === "sidecar_develop") throw new Error("path must be absolute: sidecars/pty");
      return null;
    });
    const result = await execute("sidecar.develop", { sidecarId: "soksak-sidecar-pty", path: "sidecars/pty" }, {});
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(invoke).toHaveBeenCalledWith("sidecar_develop", { id: "soksak-sidecar-pty", path: "sidecars/pty", expectedRevision: 4 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("writes the record at the current revision and reloads once", async () => {
    let environmentReads = 0;
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") {
        return environmentReads++ === 0
          ? { revision: 4, plugins: {}, sidecars: {} }
          : { revision: 5, plugins: {}, sidecars: { "soksak-sidecar-pty": { version: "0.4.0", path: "/work/pty", artifactSha256: "", source: "development", target: "darwin-arm64" } } };
      }
      if (cmd === "sidecar_develop") return { previousRevision: 4, revision: 5 };
      return null;
    });
    const result = await execute("sidecar.develop", { sidecarId: "soksak-sidecar-pty", path: "/work/pty" }, {});
    expect(result).toMatchObject({ ok: true, data: { id: "soksak-sidecar-pty", path: "/work/pty", revision: 5 } });
    expect(invoke).toHaveBeenCalledWith("sidecar_develop", { id: "soksak-sidecar-pty", path: "/work/pty", expectedRevision: 4 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The response states the record the host wrote: version is read from environment_get after the
  // write. No status field — the pre-write SIDECAR_IN_USE guard leaves open and recorded unreachable
  // after the write, so a post-write sidecar_status read has one answer.
  it("answers with the version of the written record, read from environment_get after the write", async () => {
    const written = {
      revision: 5,
      plugins: {},
      sidecars: { "soksak-sidecar-pty": { version: "0.4.0", path: "/work/pty", artifactSha256: "", source: "development", target: "darwin-arm64" } },
    };
    let environmentReads = 0;
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return environmentReads++ === 0 ? { revision: 4, plugins: {}, sidecars: {} } : written;
      if (cmd === "sidecar_develop") return { previousRevision: 4, revision: 5 };
      return null;
    });
    const result = await execute("sidecar.develop", { sidecarId: "soksak-sidecar-pty", path: "/work/pty", callerLanguage: "en" }, {});
    expect(result).toMatchObject({ ok: true, data: { id: "soksak-sidecar-pty", path: "/work/pty", revision: 5, version: "0.4.0" } });
    expect(result.data).not.toHaveProperty("status");
    expect(result.message).toBe("Recorded development record for Sidecar soksak-sidecar-pty at /work/pty (version 0.4.0)");
    expect(environmentReads).toBe(2);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "sidecar_status")).toHaveLength(1);
    expect(getSpec("sidecar.develop")!.returns).toBe("{ id, path, revision, version }");
  });

  it("the ko message carries the same information in Korean", async () => {
    let environmentReads = 0;
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") {
        return environmentReads++ === 0
          ? { revision: 4, plugins: {}, sidecars: {} }
          : { revision: 5, plugins: {}, sidecars: { "soksak-sidecar-pty": { version: "0.4.0", path: "/work/pty", artifactSha256: "", source: "development", target: "darwin-arm64" } } };
      }
      if (cmd === "sidecar_develop") return { previousRevision: 4, revision: 5 };
      return null;
    });
    const result = await execute("sidecar.develop", { sidecarId: "soksak-sidecar-pty", path: "/work/pty", callerLanguage: "ko" }, {});
    expect(result.message).not.toBe("Recorded development record for Sidecar soksak-sidecar-pty at /work/pty (version 0.4.0)");
    expect(result.message).toContain("soksak-sidecar-pty");
    expect(result.message).toContain("/work/pty");
    expect(result.message).toContain("(version 0.4.0)");
  });

  it("sidecar.remove declares sidecarId, is destructive, and declares only the codes it returns", () => {
    const spec = getSpec("sidecar.remove");
    expect(spec).toBeDefined();
    expect(spec!.params.sidecarId.required).toBe(true);
    expect(spec!.danger).toBe("destructive");
    expect(spec!.windowScoped).toBe(false);
    expect(spec!.errors).toEqual(["SIDECAR_IN_USE", "INTERNAL"]);
  });

  it("sidecar.remove removes the record at the current revision and reloads once", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return { revision: 5 };
      if (cmd === "sidecar_remove") return { previousRevision: 5, revision: 6 };
      return null;
    });
    const result = await execute("sidecar.remove", { sidecarId: "soksak-sidecar-pty" }, {});
    expect(result).toMatchObject({ ok: true, data: { id: "soksak-sidecar-pty", revision: 6 } });
    expect(invoke).toHaveBeenCalledWith("sidecar_remove", { id: "soksak-sidecar-pty", expectedRevision: 5 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("sidecar.remove publishes no artifact activity when the host deleted the artifact", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return { revision: 5 };
      if (cmd === "sidecar_remove") return { previousRevision: 5, revision: 6 };
      return null;
    });
    await execute("sidecar.remove", { sidecarId: "soksak-sidecar-pty" }, {});
    expect(invoke).not.toHaveBeenCalledWith("activity_publish", expect.objectContaining({ kind: "sidecar.remove.artifactLeft" }));
  });

  it("sidecar.remove succeeds when the host reports artifactDeleteFailed and publishes one activity naming the path", async () => {
    const artifactDeleteFailed = { path: "/home/components/sidecar/soksak-sidecar-pty/0.0.1/t/abc.removing", error: "permission denied" };
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return { revision: 5 };
      if (cmd === "sidecar_remove") return { previousRevision: 5, revision: 6, artifactDeleteFailed };
      return null;
    });
    const result = await execute("sidecar.remove", { sidecarId: "soksak-sidecar-pty" }, {});
    expect(result).toMatchObject({ ok: true, data: { id: "soksak-sidecar-pty", revision: 6 } });
    expect(invoke).toHaveBeenCalledWith("activity_publish", expect.objectContaining({
      kind: "sidecar.remove.artifactLeft",
      source: "core",
      payload: expect.objectContaining({
        id: "soksak-sidecar-pty",
        path: artifactDeleteFailed.path,
        error: artifactDeleteFailed.error,
        message: expect.stringContaining(artifactDeleteFailed.path),
      }),
    }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["open", { open: [{ name: "soksak-sidecar-pty" }], recorded: [] }],
    ["recorded", { open: [], recorded: [{ name: "soksak-sidecar-pty" }] }],
  ])("sidecar.remove refuses SIDECAR_IN_USE when sidecar_status lists the id as %s, without a host write", async (_state, status) => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return status;
      if (cmd === "environment_get") return { revision: 5 };
      if (cmd === "sidecar_remove") return { previousRevision: 5, revision: 6 };
      return null;
    });
    const result = await execute("sidecar.remove", { sidecarId: "soksak-sidecar-pty" }, {});
    expect(result).toMatchObject({ ok: false, code: "SIDECAR_IN_USE", message: expect.stringContaining("soksak-sidecar-pty") });
    expect(invoke).not.toHaveBeenCalledWith("sidecar_remove", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("environment_get");
    expect(reload).not.toHaveBeenCalled();
  });

  it("sidecar.remove returns a host refusal (unknown id) as INTERNAL with the host message in detail, without a reload", async () => {
    // The host renders the refusal sentence (i18n environment.remove.notFound); the frontend passes it through.
    const hostMessage = "host refusal for soksak-sidecar-pty";
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "sidecar_status") return { open: [], recorded: [] };
      if (cmd === "environment_get") return { revision: 5 };
      if (cmd === "sidecar_remove") throw new Error(hostMessage);
      return null;
    });
    const result = await execute("sidecar.remove", { sidecarId: "soksak-sidecar-pty" }, {});
    expect(result).toMatchObject({ ok: false, code: "INTERNAL", data: { detail: expect.stringContaining(hostMessage) } });
    expect(invoke).toHaveBeenCalledWith("sidecar_remove", { id: "soksak-sidecar-pty", expectedRevision: 5 });
    expect(reload).not.toHaveBeenCalled();
  });
});
