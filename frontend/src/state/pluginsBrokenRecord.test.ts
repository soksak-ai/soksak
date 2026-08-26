// A broken record — one the host lists but the frontend rejected (manifest unreadable, unparsable, or with
// another id) — is a host record. remove and disable look the id up in the rejected list as well as in the
// parsed runtime map: remove calls plugin_remove and drops the rejected entry; disable calls plugin_enabled_set
// with enabled false when the host record is enabled. TARGET_NOT_FOUND only when neither list has the id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/loader", () => ({
  activateContractPlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  importPluginModule: vi.fn(async () => ({ module: {}, dispose: vi.fn() })),
  activatePlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  isActive: () => false,
  setActive: () => {},
  deactivateById: vi.fn(async () => false),
  deactivateAll: vi.fn(async () => {}),
}));

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])),
}));

import { usePlugins } from "./plugins";
import { createEnvironmentEventHandler, setEnvironmentEventHandler } from "./environmentEvents";

const ID = "soksak-plugin-broken";
const DIR = `/work/${ID}`;
const rejected = { id: ID, dir: DIR, errors: [`development plugin ${ID}: directory ${DIR} is unavailable: plugin.json: unexpected end of JSON input`] };

// The host: environment_get returns the record at the current revision; a write advances it.
function host(enabled: boolean, revision = 3): { calls: Array<{ cmd: string; args: unknown }> } {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "environment_get") {
      return { revision, plugins: { [ID]: { version: "0.0.1", path: DIR, artifactSha256: "", source: "development", enabled } }, sidecars: {} };
    }
    if (cmd === "plugin_remove" || cmd === "plugin_enabled_set") {
      calls.push({ cmd, args });
      const previousRevision = revision;
      revision += 1;
      return { previousRevision, revision };
    }
    return undefined;
  });
  return { calls };
}

describe("usePlugins on a rejected host record", () => {
  const reload = vi.fn(async () => {});
  let restore: () => void = () => {};
  beforeEach(() => {
    invoke.mockReset();
    reload.mockClear();
    restore = setEnvironmentEventHandler(createEnvironmentEventHandler(reload, 3));
    usePlugins.setState({ plugins: {}, rejected: [rejected], enabledIds: [], consents: {} });
  });
  afterEach(() => {
    restore();
    usePlugins.setState({ plugins: {}, rejected: [], enabledIds: [], consents: {} });
  });

  it("remove calls plugin_remove at the current revision, drops the rejected entry, and reloads once", async () => {
    const h = host(true);
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: true, id: ID, removed: [ID] });
    expect(h.calls).toEqual([{ cmd: "plugin_remove", args: { id: ID, expectedRevision: 3 } }]);
    expect(usePlugins.getState().rejected).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("remove returns the host refusal as INTERNAL and keeps the rejected entry", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "environment_get") return { revision: 3, plugins: {}, sidecars: {} };
      if (cmd === "plugin_remove") throw new Error("refused");
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(usePlugins.getState().rejected).toEqual([rejected]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("disable of an enabled broken record calls plugin_enabled_set with enabled false and reloads once", async () => {
    const h = host(true);
    const result = await usePlugins.getState().disable(ID);
    expect(result).toMatchObject({ ok: true, id: ID, status: "disabled" });
    expect(h.calls).toEqual([
      { cmd: "plugin_enabled_set", args: { plugins: [{ id: ID, version: "0.0.1" }], enabled: false, expectedRevision: 3 } },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("disable of a disabled broken record writes nothing", async () => {
    const h = host(false);
    const result = await usePlugins.getState().disable(ID);
    expect(result).toMatchObject({ ok: true, id: ID, status: "disabled" });
    expect(h.calls).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("disable returns the host refusal as INTERNAL", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "environment_get") {
        return { revision: 3, plugins: { [ID]: { version: "0.0.1", path: DIR, artifactSha256: "", source: "development", enabled: true } }, sidecars: {} };
      }
      if (cmd === "plugin_enabled_set") throw new Error("refused");
      return undefined;
    });
    const result = await usePlugins.getState().disable(ID);
    expect(result).toMatchObject({ ok: false, code: "INTERNAL", message: expect.stringContaining("refused") });
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["remove", "disable"] as const)("%s refuses an id that neither list has, before any host call", async (op) => {
    const result = await usePlugins.getState()[op]("soksak-plugin-absent");
    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
