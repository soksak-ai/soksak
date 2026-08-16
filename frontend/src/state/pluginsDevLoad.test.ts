// devLoad reload — a dev plugin that was enabled comes back enabled after reload, with commands re-registered.
// Removes the gate in the development loop (load→enable→load→enable...): dev sources are consent-exempt (§0-5),
// so fresh code reactivates under the same consent. An id not seen before (outside enabledIds) stays disabled.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Native helper transport is injected; the store test exercises activation state only.
const activatedIds: string[] = [];
const activeIds = new Set<string>();
vi.mock("../plugins/loader", () => ({
  activateContractPlugin: vi.fn(async () => ({ deactivate: async () => {} })),
  importPluginModule: vi.fn(async () => ({})),
  activatePlugin: vi.fn(async (_m: unknown, manifest: { id: string }, dir: string) => {
    activatedIds.push(manifest.id);
    return { manifest, dir, deactivate: async () => {} };
  }),
  isActive: (id: string) => activeIds.has(id),
  setActive: (id: string) => {
    activeIds.add(id);
  },
  deactivateById: vi.fn(async (id: string) => {
    activeIds.delete(id);
    return true;
  }),
  deactivateAll: vi.fn(async () => {
    activeIds.clear();
  }),
}));

const invoke = vi.fn(async (cmd: string, args?: { path?: string }) => {
  if (cmd === "read_text_file") {
    const path = args?.path ?? "";
    if (path.endsWith("/plugin.json")) {
      return {
        content: JSON.stringify({
          spec: "0.0.1",
          id: "soksak-plugin-demo",
          name: "Demo",
          version: "1.0.0",
          description: "dev plugin for tests",
          permissions: [],
        }),
      };
    }
    // entry(main.js)
    return { content: "export const activate = () => {};" };
  }
  return undefined;
});
// The bundle arrives over the **engine resource path**, not IPC — the fixture answers on that path too.
vi.stubGlobal("fetch", async () => new Response("export const activate = () => {};"));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...(a as [string, { path?: string }])),
}));

import { usePlugins, type PluginRuntime } from "./plugins";
import { parseManifest } from "../plugins/spec";

// The folder name is not the identity. Even when it differs from the plugin.json id, load from the declared absolute source.
const PATH = "<local-evidence>/arbitrary-checkout";
const ID = "soksak-plugin-demo";

function demoRuntime(status: PluginRuntime["status"]): PluginRuntime {
  const { manifest } = parseManifest(
    {
      spec: "0.0.1",
      id: ID,
      name: "Demo",
      version: "1.0.0",
      description: "dev plugin for tests",
      permissions: [],
    },
    ID,
  );
  if (!manifest) throw new Error("test manifest invalid");
  return { manifest, dir: PATH, source: "dev", status };
}

beforeEach(() => {
  activatedIds.length = 0;
  activeIds.clear();
  invoke.mockClear();
  usePlugins.setState({
    release: false,
    plugins: {},
    rejected: [],
    consents: {},
    enabledIds: [],
  });
});

describe("devLoad — reload of an enabled dev plugin", () => {
  it("loads a local dev plugin on a release core too", async () => {
    usePlugins.setState({ release: true });

    const r = await usePlugins.getState().devLoad(PATH);

    expect(r.ok).toBe(true);
    expect(usePlugins.getState().plugins[ID]).toMatchObject({
      dir: PATH,
      source: "dev",
      status: "disabled",
    });
  });

  it("refuses a generic unit id that differs from the manifest before touching the existing selection", async () => {
    const r = await usePlugins.getState().devLoad(PATH, "different-plugin");

    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "unit_source_set")).toBe(false);
  });

  it("stays enabled after dev.load and re-registers commands when it was enabled before", async () => {
    // Precondition: already enabled and active (present in enabledIds).
    usePlugins.setState({
      plugins: { [ID]: demoRuntime("enabled") },
      enabledIds: [ID],
    });
    activeIds.add(ID); // an active instance exists

    const r = await usePlugins.getState().devLoad(PATH);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    expect(after.status).toBe("enabled");
    // Fresh code is activated again in the native runtime.
    expect(activatedIds).toContain(ID);
    expect(activeIds.has(ID)).toBe(true);
  });

  it("an id outside enabledIds stays disabled after dev.load (current behavior)", async () => {
    // No prior state — first dev.load.
    const r = await usePlugins.getState().devLoad(PATH);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    expect(after.status).toBe("disabled");
    expect(activatedIds).not.toContain(ID);
  });
});
