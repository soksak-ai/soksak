// Reload by id — re-reads that plugin's manifest from disk.
// Without the re-read, fresh code starts under the old manifest: code registering a new command is rejected
// as an undeclared command, and the error points at the cache, not the file — the author looks in the wrong place (measured).
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const ID = "soksak-plugin-demo";
// The checkout folder name is not the plugin identity. plugin.json and the selection config define the id.
const PATH = "<local-evidence>/arbitrary-checkout";

// Current manifest on disk — the test mutates it mid-run, standing in for the author editing the file.
let onDisk: Record<string, unknown> = {};
const fetchOptions: (RequestInit | undefined)[] = [];

const invoke = vi.fn(async (cmd: string, args?: { path?: string }) => {
  if (cmd === "read_text_file") {
    const path = args?.path ?? "";
    if (path.endsWith("/plugin.json")) return { content: JSON.stringify(onDisk) };
    return { content: "export const activate = () => {};" };
  }
  if (cmd === "composition_settings") return { generation: 1 };
  if (cmd === "plugin_enabled_set") return { previousGeneration: 1, generation: 2 };
  return undefined;
});
// The bundle arrives over the **engine resource path**, not IPC — the fixture answers on that path too.
// The manifest is still read over IPC (it must pass the path check). Two distinct channels is the fact
// this file records; collapsing them into one makes the test measure a world other than the real one.
vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
  fetchOptions.push(options);
  return new Response(
    String(url).endsWith("/plugin.json")
      ? JSON.stringify(onDisk)
      : "export const activate = () => {};",
  );
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...(a as [string, { path?: string }])),
}));

import { usePlugins, type PluginRuntime } from "./plugins";
import { parseManifest } from "../plugins/spec";

function manifestJson(commands: string[]): Record<string, unknown> {
  return {
    spec: "soksak-spec-plugin@0.0.1",
    id: ID,
    name: "Demo",
    version: "0.0.1",
    description: "plugin for tests",
    permissions: ["commands"],
    entry: "main.js",
    contributes: {
      commands: commands.map((name) => ({
        name,
        title: { ko: `${name} 실행`, en: `run ${name}` },
      })),
    },
  };
}

function runtimeOf(json: Record<string, unknown>, status: PluginRuntime["status"]): PluginRuntime {
  const { manifest, validation } = parseManifest(json, ID);
  if (!manifest) throw new Error(`test manifest invalid: ${validation.errors.join(", ")}`);
  return { manifest, dir: PATH, source: "dev", status };
}

beforeEach(() => {
  activatedIds.length = 0;
  activeIds.clear();
  invoke.mockClear();
  fetchOptions.length = 0;
  onDisk = manifestJson(["thing.run"]);
  usePlugins.setState({
    release: false,
    plugins: { [ID]: runtimeOf(manifestJson(["thing.run"]), "enabled") },
    rejected: [],
    consents: {},
    enabledIds: [ID],
  });
  activeIds.add(ID);
});

describe("reloadOne — a reload by id reads the manifest from disk again", () => {
  it("a command added to the file is in the declaration after reload", async () => {
    onDisk = manifestJson(["thing.run", "thing.head"]); // the author edited the file

    const r = await usePlugins.getState().reloadOne(ID);
    expect(r.ok).toBe(true);

    const after = usePlugins.getState().plugins[ID];
    const declared = (after.manifest.contributes?.commands ?? []).map((c) => c.name);
    expect(declared).toContain("thing.head");
    expect(after.status).toBe("enabled");
    expect(activatedIds).toContain(ID); // fresh code was actually activated again
    expect(invoke).toHaveBeenCalledWith("plugin_enabled_set", {
      plugins: [{ id: ID, version: "0.0.1" }], enabled: false, expectedGeneration: 1,
    });
    expect(invoke).toHaveBeenCalledWith("plugin_enabled_set", {
      plugins: [{ id: ID, version: "0.0.1" }], enabled: true, expectedGeneration: 1,
    });
  });

  it("bypasses the engine resource cache when it reloads the bundle", async () => {
    const result = await usePlugins.getState().reloadOne(ID);
    expect(result.ok).toBe(true);
    expect(fetchOptions).toContainEqual({ cache: "no-store" });
  });

  it("a malformed file answers with the refusal reason instead of silently starting on the old manifest", async () => {
    onDisk = { spec: "soksak-spec-plugin@0.0.1", id: ID }; // required fields missing

    const r = await usePlugins.getState().reloadOne(ID);
    expect(r.ok).toBe(false);
    expect(String((r as { message: string }).message)).not.toHaveLength(0);
    expect(usePlugins.getState().rejected.some((x) => x.dir === PATH)).toBe(true);
  });

  it("an unknown id is TARGET_NOT_FOUND", async () => {
    const r = await usePlugins.getState().reloadOne("soksak-plugin-nope");
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});
