// 플러그인 API 계약 — 권한 표면 게이트(§0-2)·관리 명령 차단(§0-5)·선언 외 바인딩 거부.
// deps 는 전부 가짜 주입 — Tauri/registry 실물 없이 표면 규칙만 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginApi,
  isBlockedForPlugins,
  targetPluginId,
  type PluginApiDeps,
} from "./api";
import { parseManifest, type PluginManifest } from "./spec";
import { useViewRegistry } from "./viewRegistry";
import {
  useFileViewerRegistry,
  resolveFileViewer,
} from "./fileViewerRegistry";
import {
  registerPtyIo,
  resetPtyObservationStoreForTest,
} from "../terminal/ptyObservationStore";

function manifestOf(overrides: Record<string, unknown>): PluginManifest {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-plugin-spec@1",
      id: "demo",
      name: "데모",
      version: "1.0.0",
      description: "테스트",
      permissions: [],
      ...overrides,
    },
    "demo",
  );
  if (!manifest) throw new Error(`테스트 매니페스트 불량: ${validation.errors}`);
  return manifest;
}

function fakeDeps(overrides: Partial<PluginApiDeps> = {}): PluginApiDeps {
  return {
    appVersion: "1.0.0",
    invoke: vi.fn(async () => null),
    execute: vi.fn(async () => ({ ok: true as const, code: "OK", message: "ok" })),
    registerCommand: vi.fn(),
    unregisterCommand: vi.fn(() => true),
    getCommandDanger: () => undefined,
    on: vi.fn(() => ({ dispose: () => {} })),
    currentProject: () => ({ id: "p1", root: "/repo" }),
    onFsChange: () => () => {},
    onDataChange: () => () => {},
    onClipboardChange: () => () => {},
    getCwd: () => undefined,
    subscribeCwd: () => () => {},
    subscribeCommandFinished: () => () => {},
    subscribeWebview: () => () => {},
    ...overrides,
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0 });
  useFileViewerRegistry.setState({ viewers: {}, version: 0 });
});

describe("fs.readBinary (A13 미디어 — fs:read)", () => {
  it("fs:read 권한 시 read_file_base64 로 위임", async () => {
    const invoke = vi.fn(async () => ({ mime: "image/png", base64: "AAA" }));
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["fs:read"] }),
      "/d",
      fakeDeps({ invoke }),
    );
    const r = await api.fs?.readBinary?.("/x.png");
    expect(r).toEqual({ mime: "image/png", base64: "AAA" });
    expect(invoke).toHaveBeenCalledWith("read_file_base64", { path: "/x.png" });
  });

  it("fs:read 미선언 시 fs 표면 부재", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.fs).toBeUndefined();
  });
});

describe("fs.url (로컬 파일 → webview 로드 URL — 코어 표준, 멱등)", () => {
  it("read_file_base64 로 읽어 blob URL 반환, 같은 path 멱등(invoke 1회·동일 URL)", async () => {
    let n = 0;
    const orig = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    try {
      const invoke = vi.fn(async () => ({ mime: "video/mp4", base64: "AAAA" }));
      const { api } = buildPluginApi(
        manifestOf({ permissions: ["fs:read"] }),
        "/d",
        fakeDeps({ invoke }),
      );
      const u1 = await api.fs?.url?.("/clip.mp4");
      const u2 = await api.fs?.url?.("/clip.mp4");
      expect(u1).toMatch(/^blob:/);
      expect(u1).toBe(u2); // 멱등 — 같은 path 같은 URL
      expect(invoke).toHaveBeenCalledTimes(1); // 캐시 → 재read 안 함
      expect(invoke).toHaveBeenCalledWith("read_file_base64", { path: "/clip.mp4" });
    } finally {
      URL.createObjectURL = orig;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("fs:read 미선언 시 fs.url 부재", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.fs?.url).toBeUndefined();
  });
});

describe("파일 뷰어 등록(registerFileViewer — 선언 외 거부, A13)", () => {
  it("ui 권한 + contributes.fileViewers 선언 시 등록 → resolve 매칭", () => {
    const m = manifestOf({
      permissions: ["ui"],
      contributes: { fileViewers: [{ id: "code", extensions: ["ts", "*"] }] },
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps());
    const d = api.ui?.registerFileViewer?.("code", { mount() {} });
    expect(d).toBeDefined();
    expect(resolveFileViewer("/x.ts")?.pluginId).toBe("demo");
  });

  it("선언되지 않은 파일 뷰어 등록은 throw", () => {
    const m = manifestOf({
      permissions: ["ui"],
      contributes: { fileViewers: [{ id: "code", extensions: ["ts"] }] },
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps());
    expect(() =>
      api.ui?.registerFileViewer?.("nope", { mount() {} }),
    ).toThrow();
  });
});

describe("터미널 cwd 표면(A13 raw — terminal 권한)", () => {
  it("terminal 권한 시 getCwd/onCwd/onCommandFinished 가 deps 로 위임", () => {
    const getCwd = vi.fn(() => "/cwd");
    const subscribeCwd = vi.fn(() => () => {});
    const subscribeCommandFinished = vi.fn(() => () => {});
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal"] }),
      "/d",
      fakeDeps({ getCwd, subscribeCwd, subscribeCommandFinished }),
    );
    expect(api.terminal?.getCwd?.("pane1")).toBe("/cwd");
    expect(getCwd).toHaveBeenCalledWith("pane1");
    api.terminal?.onCwd?.("pane1", () => {});
    expect(subscribeCwd).toHaveBeenCalled();
    api.terminal?.onCommandFinished?.("pane1", () => {});
    expect(subscribeCommandFinished).toHaveBeenCalled();
  });

  it("terminal 권한 미선언 시 cwd 표면(및 terminal 객체) 부재", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.terminal).toBeUndefined();
  });
});

describe("터미널 readBuffer/sendText — substrate IO 우선(GAP2, 플러그인 터미널 도달)", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("등록된 PTY IO 가 있으면 readBuffer/sendText 가 그 핸들러로 라우팅(코어 host-div 비의존)", () => {
    const sends: string[] = [];
    registerPtyIo("v9", {
      readBuffer: (lines) => `buf:${lines ?? "all"}`,
      sendInput: (data) => sends.push(data),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal:read", "terminal:write"] }),
      "/d",
      fakeDeps(),
    );
    expect(api.terminal?.readBuffer?.("v9", 3)).toBe("buf:3");
    expect(api.terminal?.sendText?.("v9", "ls\r")).toBe(true);
    expect(sends).toEqual(["ls\r"]);
  });

  it("등록된 IO 가 없으면 sendText 는 코어 host-div 폴백(없는 pane → false)", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["terminal:write"] }),
      "/d",
      fakeDeps(),
    );
    // 등록 IO 없음 + 코어 host 없음(테스트 환경) → false.
    expect(api.terminal?.sendText?.("ghost", "x")).toBe(false);
  });
});

describe("app.pty.registerIo — substrate IO 등록", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("pty 권한 시 registerIo 가 app.terminal 도달 경로를 연다(반환 Disposable 해지)", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["pty", "terminal:read"] }),
      "/d",
      fakeDeps(),
    );
    const reg = api.pty?.registerIo?.("v9", {
      readBuffer: () => "hello",
      sendInput: () => {},
    });
    expect(reg).toBeDefined();
    expect(api.terminal?.readBuffer?.("v9")).toBe("hello");
    reg!.dispose();
    expect(api.terminal?.readBuffer?.("v9")).toBeUndefined();
  });
});

describe("권한 표면 게이트(§0-2)", () => {
  it("미선언 권한의 표면은 undefined, 기본 표면(events/project)은 항상 존재", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.commands).toBeUndefined();
    expect(api.ui).toBeUndefined();
    expect(api.storage).toBeUndefined();
    expect(api.fs).toBeUndefined();
    expect(api.git).toBeUndefined();
    expect(api.events).toBeDefined();
    expect(api.project.current()).toEqual({ id: "p1", root: "/repo" });
    expect(api.appVersion).toBe("1.0.0");
    expect(api.pluginId).toBe("demo");
  });

  it("fs 는 read/write 권한별로 메서드 단위 게이트", () => {
    const ro = buildPluginApi(
      manifestOf({ permissions: ["fs:read"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(ro.fs?.readText).toBeDefined();
    expect(ro.fs?.writeText).toBeUndefined();
    const wo = buildPluginApi(
      manifestOf({ permissions: ["fs:write"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(wo.fs?.readText).toBeUndefined();
    expect(wo.fs?.writeText).toBeDefined();
  });
});

describe("commands.execute — danger ↔ 권한 매핑 + 관리 명령 차단(§0-5)", () => {
  const dangers: Record<string, "destructive" | "inject" | undefined> = {
    "view.close": "destructive",
    "term.send": "inject",
    "view.list": undefined,
  };
  const deps = () =>
    fakeDeps({ getCommandDanger: (name) => dangers[name] });

  it('danger 없는 명령은 "commands" 만으로 실행', async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      d,
    );
    expect(await api.commands!.execute("view.list")).toEqual({ ok: true, code: "OK", message: "ok" });
    expect(d.execute).toHaveBeenCalledWith("view.list", {}, {});
  });

  it.each([
    ["view.close", "commands:destructive"],
    ["term.send", "commands:inject"],
  ] as const)("danger 명령 %s 는 %s 미선언 시 거부", async (name, need) => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      deps(),
    );
    const r = await api.commands!.execute(name);
    expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect((r as { message: string }).message).toContain(need);
  });

  it("danger 권한 선언 시 통과", async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands", "commands:destructive"] }),
      "/d",
      d,
    );
    expect(await api.commands!.execute("view.close")).toEqual({ ok: true, code: "OK", message: "ok" });
  });

  it("플러그인 관리 명령은 권한과 무관하게 차단(자기증식 금지)", async () => {
    const d = deps();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive", "commands:inject"],
      }),
      "/d",
      d,
    );
    for (const name of ["plugin.enable", "plugin.install", "plugin.dev.load"]) {
      const r = await api.commands!.execute(name);
      expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    }
    expect(d.execute).not.toHaveBeenCalled();
    // 뷰 열기/플러그인 자체 명령은 관리 명령이 아님.
    expect(isBlockedForPlugins("plugin.view.open")).toBe(false);
    expect(isBlockedForPlugins("plugin.demo.go")).toBe(false);
  });
});

describe("commands.register — 매니페스트 danger 권위(U4)", () => {
  const capture = () => {
    const registered: { name: string; danger?: string }[] = [];
    const deps = fakeDeps({
      registerCommand: vi.fn((name: string, spec: { danger?: string }) => {
        registered.push({ name, danger: spec.danger });
      }),
    });
    return { deps, registered };
  };

  it("매니페스트 danger 가 registry 로 전달(권위)", () => {
    const { deps, registered } = capture();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive"],
        contributes: {
          views: [],
          commands: [{ name: "wipe", title: "지우기", danger: "destructive" }],

        },
      }),
      "/d",
      deps,
    );
    api.commands!.register("wipe", {
      description: "",
      handler: async () => ({ ok: true as const }),
    });
    expect(registered[0]).toMatchObject({
      name: "plugin.demo.wipe",
      danger: "destructive",
    });
  });

  it("런타임 danger 가 매니페스트와 다르면 거부(모순)", () => {
    const { deps } = capture();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:destructive", "commands:inject"],
        contributes: {
          views: [],
          commands: [{ name: "x", title: "엑스", danger: "destructive" }],

        },
      }),
      "/d",
      deps,
    );
    expect(() =>
      api.commands!.register("x", {
        description: "",
        danger: "inject",
        handler: async () => ({ ok: true as const }),
      }),
    ).toThrow(/danger 모순/);
  });

  it("매니페스트 미선언+런타임 danger → fallback 으로 게이트 보존(거부 안 함, warn)", () => {
    const { deps, registered } = capture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands", "commands:inject"],
        contributes: {
          views: [],
          commands: [{ name: "y", title: "와이" }],

        },
      }),
      "/d",
      deps,
    );
    api.commands!.register("y", {
      description: "",
      danger: "inject",
      handler: async () => ({ ok: true as const }),
    });
    expect(registered[0]).toMatchObject({ name: "plugin.demo.y", danger: "inject" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("commands.register — 선언 외 거부 + 네임스페이스 강제", () => {
  it("contributes.commands 에 없는 이름은 throw", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"] }),
      "/d",
      fakeDeps(),
    );
    expect(() =>
      api.commands!.register("undeclared", {
        description: "x",
        handler: () => ({}),
      }),
    ).toThrow(/선언되지 않은 명령/);
  });

  it("선언된 명령은 plugin.<id>.<name> 으로 등록되고 dispose 로 해제", () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "go", title: "고" }] },
      }),
      "/d",
      d,
    );
    const disp = api.commands!.register("go", {
      description: "x",
      handler: () => ({ done: true }),
    });
    expect(d.registerCommand).toHaveBeenCalledWith(
      "plugin.demo.go",
      expect.objectContaining({ description: "x" }),
    );
    disp.dispose();
    expect(d.unregisterCommand).toHaveBeenCalledWith("plugin.demo.go");
  });

  it("tracker.disposeAll 이 미해제 등록을 자동 수거(§0-4 누수 불가)", () => {
    const d = fakeDeps();
    const { api, tracker } = buildPluginApi(
      manifestOf({
        permissions: ["commands"],
        contributes: { commands: [{ name: "go", title: "고" }] },
      }),
      "/d",
      d,
    );
    api.commands!.register("go", { description: "x", handler: () => ({}) });
    tracker.disposeAll();
    expect(d.unregisterCommand).toHaveBeenCalledWith("plugin.demo.go");
  });
});

describe("ui — 선언 외 뷰 거부 + 레지스트리 연동", () => {
  const uiManifest = () =>
    manifestOf({
      permissions: ["ui"],
      contributes: { views: [{ id: "panel", title: "패널", icon: "P" }] },
    });

  it("선언 외 viewId 는 throw", () => {
    const { api } = buildPluginApi(uiManifest(), "/d", fakeDeps());
    expect(() => api.ui!.registerView("ghost", { mount: () => {} })).toThrow(
      /선언되지 않은 뷰/,
    );
  });

  it("등록 → viewRegistry 반영, disposeAll 로 회수", () => {
    const { api, tracker } = buildPluginApi(uiManifest(), "/d", fakeDeps());
    api.ui!.registerView("panel", { mount: () => {} });
    expect(useViewRegistry.getState().views["demo.panel"]).toBeDefined();
    tracker.disposeAll();
    expect(useViewRegistry.getState().views["demo.panel"]).toBeUndefined();
  });

  it("openView 는 plugin.view.open 으로 위임(전역 키 + 배치)", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(uiManifest(), "/d", d);
    await api.ui!.openView("panel", "content");
    expect(d.execute).toHaveBeenCalledWith(
      "plugin.view.open",
      { view: "demo.panel", placement: "content" },
      {},
    );
  });
});

describe("storage — JSON 왕복 + 전용 명령 위임", () => {
  it("write 는 직렬화해 plugin_data_write, read 는 역직렬화", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        if (cmd === "plugin_data_read") return '{"count":3}';
        return null;
      }),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["storage"] }),
      "/d",
      d,
    );
    await api.storage!.write("notes", { count: 3 });
    expect(calls[0]).toEqual({
      cmd: "plugin_data_write",
      id: "demo",
      key: "notes",
      value: '{"count":3}',
    });
    expect(await api.storage!.read("notes")).toEqual({ count: 3 });
  });

  it("미존재 키는 null", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => null) });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["storage"] }),
      "/d",
      d,
    );
    expect(await api.storage!.read("missing")).toBeNull();
  });
});

describe("data — 권한 게이트 + ns 강제 주입 + watch 필터(크로스윈도우)", () => {
  it('"data" 미선언 시 표면 undefined', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.data).toBeUndefined();
  });

  it("모든 호출에 ns=manifest.id 를 주입(다른 ns 지정 불가)", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        if (cmd === "data_put") return "rec1";
        return null;
      }),
    });
    const { api } = buildPluginApi(manifestOf({ permissions: ["data"] }), "/d", d);
    const id = await api.data!.put("messages", { title: "안녕" }, { scope: "projA" });
    expect(id).toBe("rec1");
    expect(calls[0]).toEqual({
      cmd: "data_put",
      ns: "demo",
      coll: "messages",
      scope: "projA",
      id: null,
      doc: { title: "안녕" },
    });
  });

  it("watch 는 ns·coll·scope 일치만 콜백(나머지 무시)", () => {
    let emit: ((e: unknown) => void) | null = null;
    const d = fakeDeps({
      onDataChange: (cb) => {
        emit = cb as (e: unknown) => void;
        return () => {};
      },
    });
    const { api } = buildPluginApi(manifestOf({ permissions: ["data"] }), "/d", d);
    const seen: string[] = [];
    api.data!.watch("messages", { scope: "projA" }, (e) => seen.push(e.id ?? ""));

    const ev = (o: Record<string, unknown>) => ({ ns: "demo", coll: "messages", scope: "projA", op: "put", id: "x", ...o });
    emit!(ev({})); // 일치
    emit!(ev({ ns: "other" })); // 다른 ns
    emit!(ev({ coll: "logs" })); // 다른 coll
    emit!(ev({ scope: "projB" })); // 다른 scope
    emit!(ev({ id: "y" })); // 일치(다른 id)
    expect(seen).toEqual(["x", "y"]);
  });
});

describe("secrets — 권한 게이트 + ns 강제 주입 + get 부재", () => {
  it('"secrets" 미선언 시 표면 undefined', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.secrets).toBeUndefined();
  });

  it("선언 시 set/has/delete/keys/backend 존재, get 부재(평문 readback 차단)", () => {
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["secrets"] }),
      "/d",
      fakeDeps(),
    );
    expect(typeof api.secrets?.set).toBe("function");
    expect(typeof api.secrets?.has).toBe("function");
    expect(typeof api.secrets?.delete).toBe("function");
    expect(typeof api.secrets?.keys).toBe("function");
    expect(typeof api.secrets?.backend).toBe("function");
    // get 은 존재해선 안 됨(주입 전용 — 평문 되읽기 경로 차단).
    expect((api.secrets as Record<string, unknown>).get).toBeUndefined();
  });

  it("set 은 ns=manifest.id 를 주입(다른 ns 지정 불가)", async () => {
    const calls: Record<string, unknown>[] = [];
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...args });
        return null;
      }),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["secrets"] }),
      "/d",
      d,
    );
    await api.secrets!.set("apiKey", "sk-123");
    expect(calls[0]).toEqual({
      cmd: "secret_set",
      ns: "demo",
      key: "apiKey",
      value: "sk-123",
    });
  });
});

describe("notify/sound — 권한 게이트", () => {
  it('"notify" 미선언 시 undefined, 선언 시 push/sound 표면', () => {
    const off = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(off.api.notify).toBeUndefined();
    expect(off.api.sound).toBeUndefined();
    const on = buildPluginApi(manifestOf({ permissions: ["notify"] }), "/d", fakeDeps());
    expect(typeof on.api.notify?.push).toBe("function");
    expect(on.api.sound?.builtins()).toContain("chime");
  });
});

describe("clipboard — read/write 권한별 게이트 + watch(전 창 시그널)", () => {
  it("미선언 시 표면 undefined", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.clipboard).toBeUndefined();
  });

  it("read/write 권한별 메서드 게이트(watch 는 read 소관)", () => {
    const ro = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(ro.clipboard?.readText).toBeDefined();
    expect(ro.clipboard?.watch).toBeDefined();
    expect(ro.clipboard?.writeText).toBeUndefined();

    const wo = buildPluginApi(
      manifestOf({ permissions: ["clipboard:write"] }),
      "/d",
      fakeDeps(),
    ).api;
    expect(wo.clipboard?.writeText).toBeDefined();
    expect(wo.clipboard?.readText).toBeUndefined();
    expect(wo.clipboard?.watch).toBeUndefined();
  });

  it("readText→clipboard_read, writeText→clipboard_write", async () => {
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string) =>
        cmd === "clipboard_read" ? "복사된 텍스트" : null,
      ),
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read", "clipboard:write"] }),
      "/d",
      d,
    );
    expect(await api.clipboard!.readText!()).toBe("복사된 텍스트");
    await api.clipboard!.writeText!("새 값");
    expect(d.invoke).toHaveBeenCalledWith("clipboard_write", { text: "새 값" });
  });

  it("watch 는 clipboard_watch_start + onClipboardChange 구독, dispose 시 stop", () => {
    const order: string[] = [];
    let emit: ((text: string) => void) | null = null;
    const d = fakeDeps({
      invoke: vi.fn(async (cmd: string) => {
        order.push(cmd);
        return null;
      }),
      onClipboardChange: (cb) => {
        emit = cb as (text: string) => void;
        return () => order.push("unsubscribe");
      },
    });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["clipboard:read"] }),
      "/d",
      d,
    );
    const seen: string[] = [];
    const sub = api.clipboard!.watch!((e) => seen.push(e.text));
    emit!("바뀐 내용");
    expect(seen).toEqual(["바뀐 내용"]);
    sub.dispose();
    expect(order).toContain("clipboard_watch_start");
    expect(order).toContain("clipboard_watch_stop");
  });
});

describe("git — path 기본값(활성 프로젝트 루트)", () => {
  it("path 생략 시 현재 프로젝트 루트, 루트 없으면 reject", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => []) });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["git:read"] }),
      "/d",
      d,
    );
    await api.git!.log({ limit: 5 });
    expect(d.invoke).toHaveBeenCalledWith("git_log", {
      path: "/repo",
      limit: 5,
      skip: undefined,
    });

    const noRoot = buildPluginApi(
      manifestOf({ permissions: ["git:read"] }),
      "/d",
      fakeDeps({ currentProject: () => null }),
    ).api;
    await expect(noRoot.git!.log()).rejects.toThrow(/루트 없음/);
  });
});

describe("app.scheduler — 범용 스케줄러 표면(schedule 권한)", () => {
  it('"schedule" 미선언 시 scheduler 표면 undefined', () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.scheduler).toBeUndefined();
  });

  it("register 는 트리거·명령을 wire 그대로 schedule_register 로 forward(매핑 없음)", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-7") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    const id = await api.scheduler!.register({
      trigger: { kind: "every", every_ms: 1000 },
      command: "notify.show",
      params: { title: "틱" },
      retry: { max: 3, base_ms: 1000, max_ms: 60_000 },
      timeout_ms: 600_000,
    });
    expect(id).toBe("sch-7");
    expect(d.invoke).toHaveBeenCalledWith("schedule_register", {
      trigger: { kind: "every", every_ms: 1000 },
      command: "notify.show",
      params: { title: "틱" },
      id: null,
      retry: { max: 3, base_ms: 1000, max_ms: 60_000 },
      concurrency: null,
      timeout_ms: 600_000,
      process_lease: null,
      zombie_backstop_ms: null,
    });
  });

  it("process_lease 작업 register — backstop 미지정 시 3h 기본 주입", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-2") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.exec-one",
      process_lease: true,
    });
    expect(d.invoke).toHaveBeenCalledWith(
      "schedule_register",
      expect.objectContaining({
        process_lease: true,
        zombie_backstop_ms: 10_800_000, // 3h 기본.
      }),
    );
  });

  it("process_lease + zombie_backstop_ms null → 무한(코어 None)", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-3") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.exec-one",
      process_lease: true,
      zombie_backstop_ms: null,
    });
    expect(d.invoke).toHaveBeenCalledWith(
      "schedule_register",
      expect.objectContaining({ process_lease: true, zombie_backstop_ms: null }),
    );
  });

  it("reconcile 등록 + poke(미지정)로 상태-틱 발화 요청", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => "sch-1") });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "workflow.reconcile",
    });
    await api.scheduler!.poke();
    expect(d.invoke).toHaveBeenLastCalledWith("schedule_poke", { id: null });
  });

  it("cancel/list forward", async () => {
    const d = fakeDeps({ invoke: vi.fn(async () => true) });
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      d,
    );
    await api.scheduler!.cancel("sch-3");
    expect(d.invoke).toHaveBeenCalledWith("schedule_cancel", { id: "sch-3" });
    await api.scheduler!.list();
    expect(d.invoke).toHaveBeenLastCalledWith("schedule_list");
  });
});

describe("cross-plugin 의존 게이트 (executeGated + scheduler.register, §dependencyGraph 호출경계 강제)", () => {
  it("targetPluginId — plugin.<id>.<cmd> 만 추출, 코어·view·dev·관리는 null", () => {
    expect(targetPluginId("plugin.foo-bar.baz")).toBe("foo-bar");
    expect(targetPluginId("plugin.foo-bar.baz.qux")).toBe("foo-bar"); // 다세그 cmd.
    expect(targetPluginId("notify.show")).toBeNull(); // 코어(plugin. 접두 X).
    expect(targetPluginId("plugin.view.open")).toBeNull(); // 뷰 ops.
    expect(targetPluginId("plugin.dev.load")).toBeNull(); // dev.
    expect(targetPluginId("plugin.list")).toBeNull(); // 관리(2세그).
  });

  it("미선언 cross-plugin 호출 → deny(실행 차단)", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(manifestOf({ permissions: ["commands"] }), "/d", d);
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("선언된 cross-plugin 호출 → 통과", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["commands"], dependencies: { "other-plugin": "^1.0.0" } }),
      "/d",
      d,
    );
    const out = await api.commands!.execute("plugin.other-plugin.foo");
    expect(out).toEqual({ ok: true, code: "OK", message: "ok" });
    expect(d.execute).toHaveBeenCalledWith("plugin.other-plugin.foo", {}, {});
  });

  it("자기 명령·코어·plugin.view 는 의존 무관 허용", async () => {
    const d = fakeDeps();
    const { api } = buildPluginApi(manifestOf({ permissions: ["commands"] }), "/d", d);
    expect((await api.commands!.execute("plugin.demo.foo")).ok).toBe(true); // self(id=demo).
    expect((await api.commands!.execute("notify.show")).ok).toBe(true); // 코어.
    expect((await api.commands!.execute("plugin.view.open")).ok).toBe(true); // 뷰 ops.
    expect(d.execute).toHaveBeenCalledTimes(3);
  });

  it("scheduler.register — 미선언 cross-plugin 명령 스케줄 → reject(remote 발화 우회 차단)", async () => {
    const inv = vi.fn(async () => "sch-1");
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"] }),
      "/d",
      fakeDeps({ invoke: inv }),
    );
    await expect(
      api.scheduler!.register({
        trigger: { kind: "reconcile" },
        command: "plugin.other-plugin.exec",
      }),
    ).rejects.toThrow(/other-plugin/);
    expect(inv).not.toHaveBeenCalled(); // 등록 자체 차단.
  });

  it("scheduler.register — 선언된 cross-plugin·코어 명령은 통과", async () => {
    const inv = vi.fn(async () => "sch-1");
    const { api } = buildPluginApi(
      manifestOf({ permissions: ["schedule"], dependencies: { "other-plugin": "^1.0.0" } }),
      "/d",
      fakeDeps({ invoke: inv }),
    );
    await api.scheduler!.register({
      trigger: { kind: "reconcile" },
      command: "plugin.other-plugin.exec",
    });
    await api.scheduler!.register({ trigger: { kind: "reconcile" }, command: "notify.show" });
    expect(inv).toHaveBeenCalledTimes(2);
  });
});

describe("app.sidecar — 권한 게이트 + 선언≡실물", () => {
  beforeEach(() => {
    // Tauri Channel 생성이 요구하는 내부 스텁(jsdom 에 실물 없음) — 콜백 id 발급만 흉내.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??= {
      transformCallback: () => 0,
    };
  });
  it("sidecar 권한 없으면 API 부재", () => {
    const { api } = buildPluginApi(manifestOf({}), "/d", fakeDeps());
    expect(api.sidecar).toBeUndefined();
  });
  it("선언된 사이드카만 open — 미선언 이름은 거부", async () => {
    const m = manifestOf({
      permissions: ["sidecar"],
      sidecars: [{ name: "chromium", interface: "soksak-engine-chromium@1" }],
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps());
    await expect(api.sidecar!.open("undeclared")).rejects.toThrow(/선언되지 않은 사이드카/);
  });
  it("선언된 이름 open 은 sidecar_open invoke 로 위임(선언 interface 동반)", async () => {
    const invoke = vi.fn(async () => 7);
    const m = manifestOf({
      permissions: ["sidecar"],
      sidecars: [{ name: "chromium", interface: "soksak-engine-chromium@1" }],
    });
    const { api } = buildPluginApi(m, "/d", fakeDeps({ invoke }));
    const h = await api.sidecar!.open("chromium");
    expect(invoke).toHaveBeenCalledWith(
      "sidecar_open",
      expect.objectContaining({ name: "chromium", interface: "soksak-engine-chromium@1" }),
    );
    // send 는 handle 동반 sidecar_send 위임
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    await h.send({ type: "ping" });
    expect(invoke).toHaveBeenCalledWith(
      "sidecar_send",
      expect.objectContaining({ name: "chromium", handle: 7, payload: '{"type":"ping"}' }),
    );
    // close 는 멱등
    await h.close();
    await h.close();
    const closes = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "sidecar_close",
    );
    expect(closes.length).toBe(1);
  });
});
