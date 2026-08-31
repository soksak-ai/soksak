// plugin.conformance contract test — checks that the declared≡actual runtime diagnosis judges
// every C2 composition rule. view-status (a runtime rule) is judgeable only on a mounted content
// view, so the enforcement point is this runtime surface, not the activation boundary (the only
// wiring of viewStatusConformance).
// Judgement is declared≡reported: declared (contributes.views[].status) but unreported = violation,
// reported outside the declaration = missing-declaration warning.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { registerPluginCatalog } from "./catalogPlugins";
import { execute, getSpec } from "./registry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useSessions, type Workspace, type Tab } from "../state/sessions";
import { parseManifest, type PluginManifest } from "../plugins/spec";
import { useProgramRegistry } from "../plugins/programRegistry";
import { text, withReaderLanguage } from "../i18n";
import { createEnvironmentEventHandler, setEnvironmentEventHandler } from "../state/environmentEvents";
import { usePluginSettings } from "../state/pluginSettings";

function manifestOf(id: string, overrides: Record<string, unknown> = {}): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      id,
      name: "Demo",
      version: "1.0.0",
      appVersionRequirement: "0.0.1",
      description: "Test",
      permissions: ["ui", "commands"],
      ...overrides,
    },
    id,
  );
  if (!manifest) throw new Error(`invalid test manifest: ${validation.errors}`);
  return manifest;
}

function runtimeOf(manifest: PluginManifest): PluginRuntime {
  return { manifest, dir: "/d", source: "local", status: "enabled" };
}

// Minimal tab holding plugin view instances in one content area (fills only the paths the handler reads).
function tabWith(tabs: Tab[]): Workspace {
  return {
    id: "wsp-aaaaaa",
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs, activeTabId: tabs[0]?.id ?? "" } },
        activePaneId: "pan-aaaaaa",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  } as unknown as Workspace;
}

const pluginView = (over: Partial<Tab> & { id: string; pluginId: string; view: string }): Tab =>
  ({ kind: "plugin", title: "Canvas", ...over }) as Tab;

beforeAll(() => {
  if (!getSpec("plugin.conformance")) registerPluginCatalog();
});

beforeEach(() => {
  invoke.mockClear();
  usePlugins.setState({ plugins: {} });
  useSessions.setState({ workspaces: [] });
});

afterEach(() => {
  usePlugins.setState({ plugins: {} });
  useSessions.setState({ workspaces: [] });
});

describe("plugin.conformance registration (discoverability)", () => {
  it("the returns contract declares the c2 field", () => {
    const spec = getSpec("plugin.conformance");
    expect(spec).toBeDefined();
    expect(spec!.returns).toContain("c2");
  });
});

describe("plugin installation observation", () => {
  it("publishes the batch dependency-version refusal", () => {
    expect(getSpec("plugin.install.local.batch.plan")?.errors)
      .toContain("DEPENDENCY_VERSION_CONFLICT");
    expect(getSpec("plugin.install.local.batch")?.errors)
      .toContain("DEPENDENCY_VERSION_CONFLICT");
  });

  it("starts a transaction without binding its lifetime to the renderer RPC", () => {
    expect(getSpec("plugin.install")?.params.timeoutMs).toBeUndefined();
    expect(getSpec("plugin.install")?.returns).toContain("phase");
    expect(getSpec("plugin.install.status")?.returns).toContain("completed");
    expect(getSpec("plugin.install.wait")?.params.phase).toBeDefined();
  });
});

describe("plugin.settings.set durability", () => {
  it("does not answer before the authority write completes", async () => {
    const plugin = manifestOf("settings-plugin", {
      configuration: [{
        key: "renderer", type: "enum", enum: ["canvas", "dom"], default: "canvas",
        title: { en: "Renderer", ko: "Renderer" },
      }],
    });
    usePlugins.setState({ plugins: { "settings-plugin": runtimeOf(plugin) } });
    let release!: () => void;
    const saveNow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    usePluginSettings.setState({ saveNow } as never);
    let answered = false;

    const pending = execute("plugin.settings.set", {
      id: "settings-plugin", key: "renderer", value: "dom",
    }, {}).then((result) => { answered = true; return result; });
    await Promise.resolve();

    expect(saveNow).toHaveBeenCalledOnce();
    expect(answered).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ ok: true, data: { value: "dom" } });
  });
});

describe("program.wait — poll-free program readiness boundary", () => {
  afterEach(() => {
    useProgramRegistry.setState({ programs: {}, order: [], version: 0 });
  });

  it("subscribes to the registration event and completes the moment the named program registers", async () => {
    const pending = execute("program.wait", { id: "browser", timeoutMs: 1_000 }, {});
    const dispose = useProgramRegistry.getState().register("browser-plugin", {
      id: "browser",
      title: "Browser",
      kind: "view",
      view: "browser",
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { id: "browser", pluginId: "browser-plugin" },
    });
    dispose();
  });
});

describe("tab.mount.wait — restored tab readiness", () => {
  it("is a public command with an exact tab id and finite timeout", () => {
    const spec = getSpec("tab.mount.wait");
    expect(spec?.params.tab).toMatchObject({ type: "string", required: true });
    expect(spec?.params.timeoutMs).toMatchObject({ type: "number" });
  });
});

// Contract shape of the response c2.viewStatus (declared≡reported: unreported = declared but not reported, undeclared = reported outside the declaration).
interface C2Result {
  violations: { rule: string; detail: string }[];
  viewStatus: {
    mounted: string[];
    reported: string[];
    unreported: string[];
    undeclared: { viewId: string; view: string; code: string }[];
  };
}

describe("plugin.conformance — C2 view-status (runtime verdict, viewStatusConformance wiring — declaration ≡ report)", () => {
  const declaredManifest = (id: string, status?: string[]) =>
    manifestOf(id, {
      contributes: {
        views: [
          {
            id: "canvas",
            title: "Canvas",
            icon: "C",
            surfaces: ["tab"],
            ...(status !== undefined ? { status } : {}),
          },
        ],
        commands: [{ name: "open", title: "Open" }],
        nodes: [{ id: "root" }],
      },
    });

  it("a status-declaring view that has not reported yet is information, not a violation (null = nothing to report)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["idle", "busy"])) } });
    // Two content view instances: v1 does not report status (declared → violation), v2 reports a declared code.
    useSessions.setState({
      workspaces: [
        tabWith([
          pluginView({ id: "tab-aaaaaa", pluginId: id, view: "canvas" }),
          pluginView({ id: "tab-bbbbbb", pluginId: id, view: "canvas", status: { code: "idle" } }),
        ]),
      ],
    });

    const r = await execute("plugin.conformance", { id }, {});
    expect(r.ok).toBe(true);
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2).toBeDefined();
    expect(c2.viewStatus.mounted).toEqual(["tab-aaaaaa", "tab-bbbbbb"]);
    expect(c2.viewStatus.reported).toEqual(["tab-bbbbbb"]);
    expect(c2.viewStatus.unreported).toEqual(["tab-aaaaaa"]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
  });

  it("no view-status violation when every content view reports a declared code", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["running"])) } });
    useSessions.setState({
      workspaces: [tabWith([pluginView({ id: "tab-aaaaaa", pluginId: id, view: "canvas", status: { code: "running" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.unreported).toEqual([]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
    expect(c2.violations.map((v) => v.rule)).not.toContain("content-view-status");
  });

  it("silence from a stateless ([]) declaration is not a violation (declaration ≡ report)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, [])) } });
    useSessions.setState({
      workspaces: [tabWith([pluginView({ id: "tab-aaaaaa", pluginId: id, view: "canvas" })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.unreported).toEqual([]);
    expect(c2.viewStatus.undeclared).toEqual([]);
    expect(c2.violations.map((v) => v.rule)).not.toContain("view-status");
    expect(c2.violations.map((v) => v.rule)).not.toContain("content-view-status");
  });

  it("report without declaration → undeclared = view-status violation (code outside the declaration)", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, undefined)) } });
    useSessions.setState({
      workspaces: [tabWith([pluginView({ id: "tab-aaaaaa", pluginId: id, view: "canvas", status: { code: "idle" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.undeclared).toEqual([{ viewId: "tab-aaaaaa", view: "canvas", code: "idle" }]);
    const vs = c2.violations.filter((v) => v.rule === "view-status");
    expect(vs.some((v) => v.detail.includes("idle"))).toBe(true);
  });

  it("reporting a code outside the declared list → undeclared = view-status violation", async () => {
    const id = "demo";
    usePlugins.setState({ plugins: { [id]: runtimeOf(declaredManifest(id, ["ready"])) } });
    useSessions.setState({
      workspaces: [tabWith([pluginView({ id: "tab-aaaaaa", pluginId: id, view: "canvas", status: { code: "wat" } })])],
    });

    const r = await execute("plugin.conformance", { id }, {});
    const c2 = (r as { data: Record<string, unknown> }).data.c2 as C2Result;
    expect(c2.viewStatus.undeclared).toEqual([{ viewId: "tab-aaaaaa", view: "canvas", code: "wat" }]);
    const vs = c2.violations.filter((v) => v.rule === "view-status");
    expect(vs.some((v) => v.detail.includes("wat"))).toBe(true);
  });
});

describe("plugin.conformance — C2 static rules (command-surface, view-nodes)", () => {
  // A capability with no command is unreachable from outside (C2). The case was written against a
  // file viewer until 2026-08-16; the rule is about capability-with-no-command, and a view is one.
  it("a view only and command=0 → command-surface in c2.violations", async () => {
    const id = "viewer";
    const manifest = manifestOf(id, {
      permissions: ["ui"],
      contributes: {
        views: [{ id: "image", title: { en: "Image", ko: "Image" }, icon: "file", surfaces: ["tab"] }],
      },
    });
    usePlugins.setState({ plugins: { [id]: runtimeOf(manifest) } });

    const r = await execute("plugin.conformance", { id }, {});
    const data = (r as { data: Record<string, unknown> }).data;
    const c2 = data.c2 as { violations: { rule: string }[] };
    expect(c2.violations.map((v) => v.rule)).toContain("command-surface");
  });
});

describe("plugin.view.open — only a center view opens as a tab", () => {
  it("documents and reports only the current viewKey/workspace contract", async () => {
    const spec = getSpec("plugin.view.open")!;
    expect(Object.keys(spec.params)).toEqual(["viewKey", "workspace"]);
    expect(spec.examples).toEqual([
      `plugin.view.open '{"viewKey":"soksak-plugin-<id>.<view>"}'`,
    ]);
    expect(withReaderLanguage("en", () => text(spec.description))).not.toContain("placement");
    useSessions.setState({ workspaces: [tabWith([])], activeId: "wsp-aaaaaa" } as never);
    const { useViewRegistry } = await import("../plugins/viewRegistry");
    const off = useViewRegistry.getState().register(
      "demo",
      { id: "panel", title: "Panel", icon: "P", surfaces: ["tab"], transparent: false, nativeSurface: false },
      { mount: () => {} },
    );
    try {
      const result = await execute("plugin.view.open", { viewKey: "demo.panel", callerLanguage: "en" }, {});
      expect(result.message).toBe("Opened demo.panel");
    } finally {
      off();
    }
  });

  it("a view that lives beside the work is refused a tab, and the refusal names its surface", async () => {
    const { useViewRegistry } = await import("../plugins/viewRegistry");
    useViewRegistry.getState().register(
      "railplug",
      {
        id: "tree",
        title: "tree",
        icon: "x",
        surfaces: ["side"],
        transparent: false,
        nativeSurface: false,
      },
      { mount: () => {} },
    );
    useSessions.setState({ workspaces: [tabWith([])], activeId: "wsp-aaaaaa" } as never);
    const r = (await execute("plugin.view.open", { viewKey: "railplug.tree" }, {})) as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    // The refusal names the view's actual surface — a caller told only "no" looks for a bug. A
    // surface and not a place: this view stands wherever a person put the set holding it, so there
    // is no one place to name.
    expect(r.message).toContain("side");
  });
});

// Rule — a fact in the manifest must also be on the state surface.
//
// The contract implementation declaration (implements) is in the manifest, but plugin.list did not
// emit it. There was no place to ask "who implements this contract", so the consumer (the E2E
// harness) used a hand-written table of plugin ids — that table needs an edit whenever a plugin is
// added, and it diverges silently whenever a plugin changes its contract.
// Measured 2026-08-07: that silent divergence killed engine execution with a `traceId must be number` rejection.
describe("plugin.list — contract discovery", () => {
  it("exposes provider versions and consumer ranges from the manifest", async () => {
    const provider = manifestOf("provider", {
      implements: [{ id: "soksak-spec-plugin-terminal-renderer", version: "0.0.1" }],
    });
    const consumer = manifestOf("consumer", {
      consumes: [{ id: "soksak-spec-plugin-terminal-renderer", requirement: "0.0.1" }],
    });
    usePlugins.setState({
      plugins: {
        provider: runtimeOf(provider),
        consumer: runtimeOf(consumer),
      },
    });

    const result = await execute("plugin.list", {}, {});
    expect(result.ok).toBe(true);
    const plugins = (result as unknown as { data: { plugins: Record<string, unknown>[] } }).data.plugins;
    expect(plugins.find((plugin) => plugin.id === "provider")?.implements).toEqual([
      { id: "soksak-spec-plugin-terminal-renderer", version: "0.0.1" },
    ]);
    expect(plugins.find((plugin) => plugin.id === "consumer")?.consumes).toEqual([
      { id: "soksak-spec-plugin-terminal-renderer", requirement: "0.0.1" },
    ]);
  });
});

// plugin.develop — one environment write that pins a source directory as the plugin's record.
// The reload runs through the environment revision coordinator once; the environment.changed event
// for the same revision is then a no-op. The host validates the path; the frontend passes it through.
describe("plugin.develop", () => {
  const reload = vi.fn(async () => {});
  let restore: () => void = () => {};
  beforeEach(() => {
    reload.mockClear();
    restore = setEnvironmentEventHandler(createEnvironmentEventHandler(reload, 1));
  });
  afterEach(() => restore());

  it("declares id and path, and is destructive because it replaces the existing record", () => {
    const spec = getSpec("plugin.develop");
    expect(spec).toBeDefined();
    expect(spec!.params.id.required).toBe(true);
    expect(spec!.params.path.required).toBe(true);
    expect(spec!.danger).toBe("destructive");
    expect(spec!.windowScoped).toBe(false);
  });

  it("passes a relative path to the host unchanged; the host validates the path", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "environment_get") return { revision: 1 };
      if (cmd === "plugin_develop") throw new Error("path must be absolute: plugins/demo");
      return null;
    });
    const r = await execute("plugin.develop", { id: "soksak-plugin-demo", path: "plugins/demo" }, {});
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(invoke).toHaveBeenCalledWith("plugin_develop", { id: "soksak-plugin-demo", path: "plugins/demo", expectedRevision: 1 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("writes the record at the current revision and reloads once", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "environment_get") return { revision: 1 };
      if (cmd === "plugin_develop") return { previousRevision: 1, revision: 2 };
      return null;
    });
    const r = await execute("plugin.develop", { id: "soksak-plugin-demo", path: "/work/demo" }, {});
    expect(r).toMatchObject({ ok: true, data: { id: "soksak-plugin-demo", path: "/work/demo", revision: 2 } });
    expect(invoke).toHaveBeenCalledWith("plugin_develop", {
      id: "soksak-plugin-demo", path: "/work/demo", expectedRevision: 1,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The response states the state the reload produced. Measured 2026-08-26: plugin.develop answered
  // ok with { id, path, revision } while the reloaded plugin stayed disabled with a consent-required
  // error, and the pane showed the placeholder; the response had no field for that.
  it("returns the runtime status and error after the reload: consent required is status disabled", async () => {
    usePlugins.setState({ plugins: {}, rejected: [] });
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "environment_get") return { revision: 1 };
      if (cmd === "plugin_develop") return { previousRevision: 1, revision: 2 };
      return null;
    });
    reload.mockImplementationOnce(async () => {
      usePlugins.setState({
        plugins: {
          "soksak-plugin-demo": {
            manifest: manifestOf("soksak-plugin-demo"),
            dir: "/work/demo",
            source: "development",
            status: "disabled",
            error: "consent required: permissions ui, commands",
          },
        },
      });
    });
    const r = await execute("plugin.develop", { id: "soksak-plugin-demo", path: "/work/demo", callerLanguage: "en" }, {});
    expect(r).toMatchObject({
      ok: true,
      data: { id: "soksak-plugin-demo", path: "/work/demo", revision: 2, status: "disabled", error: "consent required: permissions ui, commands" },
    });
    expect(r.message).toBe(
      "Recorded development record for Plugin soksak-plugin-demo at /work/demo; status disabled: consent required: permissions ui, commands",
    );
  });

  it("returns status rejected with the rejection errors joined when only the rejected list holds the id", async () => {
    usePlugins.setState({ plugins: {}, rejected: [] });
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "environment_get") return { revision: 1 };
      if (cmd === "plugin_develop") return { previousRevision: 1, revision: 2 };
      return null;
    });
    reload.mockImplementationOnce(async () => {
      usePlugins.setState({
        rejected: [{ id: "soksak-plugin-demo", dir: "/work/demo", errors: ["permissions: empty", "entry: missing"] }],
      });
    });
    const r = await execute("plugin.develop", { id: "soksak-plugin-demo", path: "/work/demo", callerLanguage: "en" }, {});
    expect(r).toMatchObject({
      ok: true,
      data: { status: "rejected", error: "permissions: empty; entry: missing" },
    });
    expect(r.message).toContain("status rejected: permissions: empty; entry: missing");
  });

  it("returns status enabled without an error field when the reload enabled the plugin", async () => {
    usePlugins.setState({ plugins: {}, rejected: [] });
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "environment_get") return { revision: 1 };
      if (cmd === "plugin_develop") return { previousRevision: 1, revision: 2 };
      return null;
    });
    reload.mockImplementationOnce(async () => {
      usePlugins.setState({ plugins: { "soksak-plugin-demo": runtimeOf(manifestOf("soksak-plugin-demo")) } });
    });
    const r = await execute("plugin.develop", { id: "soksak-plugin-demo", path: "/work/demo", callerLanguage: "en" }, {});
    expect(r).toMatchObject({ ok: true, data: { status: "enabled" } });
    expect((r as { data: Record<string, unknown> }).data).not.toHaveProperty("error");
    expect(r.message).toBe("Recorded development record for Plugin soksak-plugin-demo at /work/demo; status enabled");
  });
});
