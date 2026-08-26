// plugin removal — host first: read the revision, plugin_remove at that revision (compare-and-swap). Only after
// the host accepted: deactivate the in-memory instance, clear consent/enabled state, reconcile once through the
// environment coordinator. A host refusal changes nothing in the frontend. The host owns the removal rule
// (development record → record only; local/registry record → record and artifact directory under <home>/components/).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { active, deactivateById } = vi.hoisted(() => ({
  active: new Set<string>(),
  deactivateById: vi.fn(async (id: string) => active.delete(id)),
}));

vi.mock("../plugins/loader", () => ({
  activateContractPlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  importPluginModule: vi.fn(async () => ({ module: {}, dispose: vi.fn() })),
  activatePlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  isActive: (id: string) => active.has(id),
  setActive: (id: string) => { active.add(id); },
  deactivateById: (id: string) => deactivateById(id),
  deactivateAll: vi.fn(async () => { active.clear(); }),
}));

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])),
}));

import { usePlugins, type PluginRuntime } from "./plugins";
import { parseManifest } from "../plugins/spec";
import { createEnvironmentEventHandler, setEnvironmentEventHandler } from "./environmentEvents";

const ID = "soksak-plugin-demo";
const DEPENDENT = "soksak-plugin-dependent";

function runtime(
  source: PluginRuntime["source"],
  id = ID,
  extra: Record<string, unknown> = {},
  status: PluginRuntime["status"] = "disabled",
): PluginRuntime {
  const { manifest, validation } = parseManifest(
    { id, name: "Demo", version: "0.0.1", appVersionRequirement: "0.0.1", description: "Test", permissions: ["commands"], ...extra },
    id,
  );
  if (!manifest) throw new Error(`invalid test manifest: ${validation.errors}`);
  return { manifest, dir: `/work/${id}`, source, status };
}

// The host: environment_get returns the current revision; plugin_remove advances it.
function hostAt(revision: number): { calls: string[] } {
  const calls: string[] = [];
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "environment_get") return { revision };
    if (cmd === "plugin_remove") {
      calls.push((args as { id: string }).id);
      const previousRevision = revision;
      revision += 1;
      return { previousRevision, revision };
    }
    return undefined;
  });
  return { calls };
}

describe("usePlugins.remove", () => {
  const reload = vi.fn(async () => {});
  let restore: () => void = () => {};
  beforeEach(() => {
    invoke.mockReset();
    reload.mockClear();
    deactivateById.mockClear();
    active.clear();
    restore = setEnvironmentEventHandler(createEnvironmentEventHandler(reload, 3));
  });
  afterEach(() => {
    restore();
    usePlugins.setState({ plugins: {}, enabledIds: [], consents: {} });
  });

  it.each(["development", "local"] as const)("removes a %s record at the current revision and reloads once", async (source) => {
    usePlugins.setState({ plugins: { [ID]: runtime(source) } });
    hostAt(3);
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: true, id: ID, removed: [ID] });
    expect(invoke).toHaveBeenCalledWith("plugin_remove", { id: ID, expectedRevision: 3 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown id before any environment read", async () => {
    const result = await usePlugins.getState().remove("soksak-plugin-absent");
    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(invoke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("returns a host refusal as INTERNAL and leaves status, enabledIds, consent, and the instance unchanged", async () => {
    const consent = { version: "0.0.1", permissions: ["commands" as const] };
    usePlugins.setState({ plugins: { [ID]: runtime("local", ID, {}, "enabled") }, enabledIds: [ID], consents: { [ID]: consent } });
    active.add(ID);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "environment_get") return { revision: 3 };
      if (cmd === "plugin_remove") throw new Error("artifact path /elsewhere is not under /home/components; the record is kept");
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: false, code: "INTERNAL", message: expect.stringContaining("/elsewhere") });
    expect(usePlugins.getState().plugins[ID]?.status).toBe("enabled");
    expect(usePlugins.getState().enabledIds).toEqual([ID]);
    expect(usePlugins.getState().consents[ID]).toEqual(consent);
    expect(active.has(ID)).toBe(true);
    expect(deactivateById).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("plugin_enabled_set", expect.anything());
    expect(reload).not.toHaveBeenCalled();
  });

  it("deactivates the instance and clears consent/enabled only after the host removed the record, without an enabled write", async () => {
    usePlugins.setState({
      plugins: { [ID]: runtime("registry", ID, {}, "enabled") },
      enabledIds: [ID],
      consents: { [ID]: { version: "0.0.1", permissions: ["commands"] } },
    });
    active.add(ID);
    const order: string[] = [];
    deactivateById.mockImplementation(async (id: string) => { order.push(`deactivate:${id}`); return active.delete(id); });
    hostAt(3);
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "environment_get") return { revision: 3 };
      if (cmd === "plugin_remove") { order.push(`plugin_remove:${(args as { id: string }).id}`); return { previousRevision: 3, revision: 4 }; }
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: true, id: ID, removed: [ID] });
    expect(order).toEqual([`plugin_remove:${ID}`, `deactivate:${ID}`]);
    expect(invoke).not.toHaveBeenCalledWith("plugin_enabled_set", expect.anything());
    expect(usePlugins.getState().enabledIds).toEqual([]);
    expect(usePlugins.getState().consents[ID]).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("succeeds when the host reports artifactDeleteFailed: consent and enabled state cleared, one activity names the path", async () => {
    usePlugins.setState({
      plugins: { [ID]: runtime("local", ID, {}, "enabled") },
      enabledIds: [ID],
      consents: { [ID]: { version: "0.0.1", permissions: ["commands"] } },
    });
    active.add(ID);
    const artifactDeleteFailed = { path: `/home/components/plugin/${ID}/0.0.1/abc.removing`, error: "permission denied" };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "environment_get") return { revision: 3 };
      if (cmd === "plugin_remove") return { previousRevision: 3, revision: 4, artifactDeleteFailed };
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: true, id: ID, removed: [ID] });
    expect(usePlugins.getState().enabledIds).toEqual([]);
    expect(usePlugins.getState().consents[ID]).toBeUndefined();
    expect(active.has(ID)).toBe(false);
    expect(invoke).toHaveBeenCalledWith("activity_publish", expect.objectContaining({
      kind: "plugin.remove.artifactLeft",
      source: "plugins",
      payload: expect.objectContaining({
        id: ID,
        path: artifactDeleteFailed.path,
        error: artifactDeleteFailed.error,
        message: expect.stringContaining(artifactDeleteFailed.path),
      }),
    }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("publishes no artifact activity when the host deleted the artifact", async () => {
    usePlugins.setState({ plugins: { [ID]: runtime("local") } });
    hostAt(3);
    const result = await usePlugins.getState().remove(ID);
    expect(result).toMatchObject({ ok: true, id: ID, removed: [ID] });
    expect(invoke).not.toHaveBeenCalledWith("activity_publish", expect.objectContaining({ kind: "plugin.remove.artifactLeft" }));
  });

  it("cascade continues past a dependent whose artifact was left behind", async () => {
    const dependency = [{ id: ID, version: "0.0.1" }];
    usePlugins.setState({
      plugins: {
        [ID]: runtime("local"),
        [DEPENDENT]: runtime("local", DEPENDENT, { runtimeDependencies: { plugins: dependency } }),
      },
      enabledIds: [ID, DEPENDENT],
    });
    let revision = 3;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "environment_get") return { revision };
      if (cmd === "plugin_remove") {
        const id = (args as { id: string }).id;
        revision += 1;
        const change = { previousRevision: revision - 1, revision };
        return id === DEPENDENT ? { ...change, artifactDeleteFailed: { path: `/home/components/plugin/${DEPENDENT}/0.0.1/abc.removing`, error: "busy" } } : change;
      }
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID, { cascade: true });
    expect(result).toMatchObject({ ok: true, id: ID, removed: [DEPENDENT, ID] });
    expect(invoke).toHaveBeenCalledWith("plugin_remove", { id: ID, expectedRevision: 4 });
    expect(invoke).toHaveBeenCalledWith("activity_publish", expect.objectContaining({
      kind: "plugin.remove.artifactLeft",
      payload: expect.objectContaining({ id: DEPENDENT }),
    }));
    expect(usePlugins.getState().enabledIds).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cascade removes the dependent first, each at the host's current revision, and reloads once at the end", async () => {
    const dependency = [{ id: ID, version: "0.0.1" }];
    usePlugins.setState({
      plugins: {
        [ID]: runtime("local"),
        [DEPENDENT]: runtime("local", DEPENDENT, { runtimeDependencies: { plugins: dependency } }),
      },
      enabledIds: [ID, DEPENDENT],
    });
    const host = hostAt(3);
    const blocked = await usePlugins.getState().remove(ID);
    expect(blocked).toMatchObject({ ok: false, code: "CASCADE_REQUIRED" });
    expect(host.calls).toEqual([]);

    const result = await usePlugins.getState().remove(ID, { cascade: true });
    expect(result).toMatchObject({ ok: true, id: ID, removed: [DEPENDENT, ID] });
    expect(host.calls).toEqual([DEPENDENT, ID]);
    expect(invoke).toHaveBeenCalledWith("plugin_remove", { id: DEPENDENT, expectedRevision: 3 });
    expect(invoke).toHaveBeenCalledWith("plugin_remove", { id: ID, expectedRevision: 4 });
    expect(usePlugins.getState().enabledIds).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cascade stops at the first host refusal and reconciles the records already removed", async () => {
    const dependency = [{ id: ID, version: "0.0.1" }];
    usePlugins.setState({
      plugins: {
        [ID]: runtime("local"),
        [DEPENDENT]: runtime("local", DEPENDENT, { runtimeDependencies: { plugins: dependency } }),
      },
      enabledIds: [ID, DEPENDENT],
    });
    let revision = 3;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "environment_get") return { revision };
      if (cmd === "plugin_remove") {
        const id = (args as { id: string }).id;
        if (id === ID) throw new Error("refused");
        revision += 1;
        return { previousRevision: revision - 1, revision };
      }
      return undefined;
    });
    const result = await usePlugins.getState().remove(ID, { cascade: true });
    expect(result).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(usePlugins.getState().enabledIds).toEqual([ID]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
