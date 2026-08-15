// Command Registry contract test — validation matrix, ok wrapping, permission gate, register and
// unregister. registry is module-global state, so each test cleans up the commands it registered.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogJson, composeTriggers, effectiveSpeak, execute, getSpec, register, setPermissionGate, unregister, type CommandSpec, type CommandOutcome, setUnknownCommandResolver, type CommandTrace } from "./registry";
import { setCommandTraceSink } from "./commandObservation";

const TEST_PREFIX = "test.";
const registered: string[] = [];

function reg(name: string, spec: Partial<CommandSpec>): void {
  register(name, {
    description: "test command",
    params: {},
    returns: "test",
    message: () => "done",
    handler: () => ({}),
    ...spec,
  });
  registered.push(name);
}

afterEach(() => {
  for (const name of registered.splice(0)) unregister(name);
  setPermissionGate(() => true);
});

describe("execute — base contract", () => {
  it("gives UNKNOWN_COMMAND for an unknown name", async () => {
    // A non-empty registry is required to measure "no such name" — an empty registry is a different
    // fact and answers with a different code.
    reg(TEST_PREFIX + "present", { handler: () => ({}) });
    const r = await execute(TEST_PREFIX + "nope", {}, {});
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  it("wraps a plain object handler return as ok:true", async () => {
    reg(TEST_PREFIX + "plain", { handler: () => ({ value: 7 }) });
    const r = await execute(TEST_PREFIX + "plain", {}, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "done", data: { value: 7 }, window: "" });
  });

  it("passes a handler CmdResult({ok:false}) through unchanged", async () => {
    reg(TEST_PREFIX + "err", {
      handler: () => ({ ok: false, code: "TARGET_NOT_FOUND", message: "not found" }),
    });
    const r = await execute(TEST_PREFIX + "err", {}, {});
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });

  it("converts a handler throw to INTERNAL — the host stays up", async () => {
    reg(TEST_PREFIX + "boom", {
      handler: () => {
        throw new Error("blast");
      },
    });
    const r = await execute(TEST_PREFIX + "boom", {}, {});
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
    expect((r as { data?: { detail?: string } }).data?.detail).toContain("blast");
  });

  // Raw exception text is engine dialect — put on the human line (message), a consumer reads it as
  // app state. Measured (2026-07-13): under machine memory pressure SQLite threw "out of memory", it
  // surfaced as message, and was misread as "the app died". The raw text is not dropped; it is kept
  // in data.detail (machine payload).
  it("puts raw engine text in data.detail, not on the human line", async () => {
    reg(TEST_PREFIX + "nomem", {
      handler: () => {
        throw new Error("out of memory");
      },
    });
    const r = await execute(TEST_PREFIX + "nomem", {}, {});
    const out = r as { code: string; message: string; data?: { detail?: string } };
    expect(out.code).toBe("INTERNAL");
    expect(out.message).not.toContain("out of memory");
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.data?.detail).toContain("out of memory");
  });

  it("converts an async handler reject to INTERNAL too", async () => {
    reg(TEST_PREFIX + "reject", {
      handler: async () => {
        throw new Error("async failure");
      },
    });
    const r = await execute(TEST_PREFIX + "reject", {}, {});
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("speech axis — display (message) and speech (speak), nothing else (§3)", () => {
  const spec = (speak?: (out: CommandOutcome) => string): CommandSpec =>
    ({ description: "d", params: {}, returns: "r", message: () => "done", handler: () => ({}), ...(speak ? { speak } : {}) }) as CommandSpec;
  const out = (message: string, ok = true): CommandOutcome =>
    ({ ok, code: ok ? "OK" : "INTERNAL", message }) as CommandOutcome;

  it("no speak means silence — speech is opt-in, with no message fallback", () => {
    expect(effectiveSpeak(spec(), out("done"))).toBeUndefined();
  });
  it("with speak declared, speak(outcome) is the sentence on success and failure alike — paths stay on message", () => {
    const s = spec((o) => (o.ok ? "Saved the screen." : o.message));
    expect(effectiveSpeak(s, out("Saved: <local-evidence>/a.png"))).toBe("Saved the screen.");
    expect(effectiveSpeak(s, out("failure detail", false))).toBe("failure detail");
  });
  it('speak "" means silence — the only block on say-style feedback', () => {
    expect(effectiveSpeak(spec(() => ""), out("anything"))).toBeUndefined();
  });
  it('execute trace carries tts only for commands that declare speak', async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    reg("test.tts-on", { message: () => "seen", speak: () => "spoken", handler: () => ({}) });
    reg("test.tts-off", { message: () => "seen", handler: () => ({}) }); // no speak means silence (opt-in)
    await execute("test.tts-on", {}, { remote: false });
    await execute("test.tts-off", {}, { remote: false });
    setCommandTraceSink(null);
    expect(traces.find((t) => t.command.endsWith("tts-on"))?.speak).toBe("spoken");
    expect(traces.find((t) => t.command.endsWith("tts-off"))?.speak).toBeUndefined();
  });
});

describe("execute — parameter validation matrix", () => {
  it("rejects an undeclared parameter, catching a typo early", async () => {
    reg(TEST_PREFIX + "strict", { params: {} });
    const r = await execute(TEST_PREFIX + "strict", { typo: 1 }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("rejects a missing required parameter", async () => {
    reg(TEST_PREFIX + "req", {
      params: { id: { type: "string", description: "", required: true } },
    });
    const r = await execute(TEST_PREFIX + "req", {}, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it.each([
    ["string", 1],
    ["number", "x"],
    ["boolean", "true"],
    ["string[]", [1]],
    ["number[]", ["x"]],
  ] as const)("rejects a type mismatch: %s", async (type, bad) => {
    const name = TEST_PREFIX + "type-" + type;
    reg(name, { params: { v: { type, description: "" } } });
    const r = await execute(name, { v: bad }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("rejects a value outside enum and allows one inside", async () => {
    reg(TEST_PREFIX + "enum", {
      params: {
        mode: { type: "string", description: "", enum: ["a", "b"] },
      },
      handler: (p) => ({ mode: p.mode }),
    });
    expect(await execute(TEST_PREFIX + "enum", { mode: "c" }, {})).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await execute(TEST_PREFIX + "enum", { mode: "a" }, {})).toEqual({ ok: true, code: "OK", message: "done", data: { mode: "a" }, window: "" });
  });

  it("passes any value for the json type, leaving it to the handler", async () => {
    reg(TEST_PREFIX + "json", {
      params: { v: { type: "json", description: "" } },
      handler: (p) => ({ got: p.v }),
    });
    const r = await execute(TEST_PREFIX + "json", { v: { deep: [1] } }, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "done", data: { got: { deep: [1] } }, window: "" });
  });

  it("fills default when unspecified and keeps the given value otherwise", async () => {
    reg(TEST_PREFIX + "def", {
      params: { n: { type: "number", description: "", default: 10 } },
      handler: (p) => ({ n: p.n }),
    });
    expect(await execute(TEST_PREFIX + "def", {}, {})).toEqual({ ok: true, code: "OK", message: "done", data: { n: 10 }, window: "" });
    expect(await execute(TEST_PREFIX + "def", { n: 3 }, {})).toEqual({ ok: true, code: "OK", message: "done", data: { n: 3 }, window: "" });
  });
});

describe("execute — permission gate", () => {
  it("gives PERMISSION_DENIED for remote danger when the gate refuses", async () => {
    reg(TEST_PREFIX + "danger", { danger: "destructive", handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "danger", {}, { remote: true });
    expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("exempts a UI (non-remote) call from the gate — a person is trusted", async () => {
    reg(TEST_PREFIX + "danger2", { danger: "inject", handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "danger2", {}, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "done", data: { did: true }, window: "" });
  });

  it("runs remote danger when the gate allows it", async () => {
    reg(TEST_PREFIX + "danger3", { danger: "destructive", handler: () => ({ did: true }) });
    setPermissionGate(() => true);
    const r = await execute(TEST_PREFIX + "danger3", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "done", data: { did: true }, window: "" });
  });

  it("leaves a command with no danger class outside the gate", async () => {
    reg(TEST_PREFIX + "safe", { handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "safe", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "done", data: { did: true }, window: "" });
  });
});

describe("register / unregister — plugin lifetime", () => {
  it("gives UNKNOWN_COMMAND after unregister, and getSpec returns undefined", async () => {
    // One registration stays — removing the last one empties the registry, and that is a different
    // fact from "no such name".
    reg(TEST_PREFIX + "stays", {});
    reg(TEST_PREFIX + "gone", {});
    expect(getSpec(TEST_PREFIX + "gone")).toBeDefined();
    expect(unregister(TEST_PREFIX + "gone")).toBe(true);
    expect(getSpec(TEST_PREFIX + "gone")).toBeUndefined();
    const r = await execute(TEST_PREFIX + "gone", {}, {});
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  it("returns false when unregistering a name that was never registered", () => {
    expect(unregister(TEST_PREFIX + "never-registered")).toBe(false);
  });

  it("leaves an unregistered command out of catalogJson", () => {
    reg(TEST_PREFIX + "cat", {});
    expect(catalogJson().some((c) => c.name === TEST_PREFIX + "cat")).toBe(true);
    unregister(TEST_PREFIX + "cat");
    expect(catalogJson().some((c) => c.name === TEST_PREFIX + "cat")).toBe(false);
  });

  it("sorts catalogJson by name and omits the handler, so it serializes", () => {
    reg(TEST_PREFIX + "z-last", {});
    reg(TEST_PREFIX + "a-first", {});
    const names = catalogJson().map((c) => c.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const entry = catalogJson().find((c) => c.name === TEST_PREFIX + "a-first");
    expect(entry).toBeDefined();
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect("handler" in (entry as object)).toBe(false);
  });

  // composeTriggers — LLM discovery surface (decision 8): English base composed with trigger words
  // from every language. Not a locale copy.
  it("composeTriggers: gives base unchanged with no triggers (backward compatible)", () => {
    expect(composeTriggers("Split the panel.")).toBe("Split the panel.");
    expect(composeTriggers("Split the panel.", undefined)).toBe("Split the panel.");
    expect(composeTriggers("Split the panel.", {})).toBe("Split the panel.");
  });
  it("composeTriggers: base + ' | ' + per-language trigger words, with no label", () => {
    expect(composeTriggers("Split the panel.", { ko: "패널 나누기 분할" })).toBe(
      "Split the panel. | 패널 나누기 분할",
    );
  });
  it("composeTriggers: sorts language codes alphabetically — deterministic and independent of the conversation language", () => {
    // ko, ja → sorted, ja comes first (j<k). Input order does not matter.
    const out = composeTriggers("Draw.", { ko: "낙서 그리기", ja: "落書き 描く" });
    expect(out).toBe("Draw. | 落書き 描く | 낙서 그리기");
    // Same result with the input order swapped (determinism).
    expect(composeTriggers("Draw.", { ja: "落書き 描く", ko: "낙서 그리기" })).toBe(out);
  });
  it("composeTriggers: adding a language (zh) changes only that data in the composition and leaves the rest unchanged", () => {
    const base2 = composeTriggers("Draw.", { ko: "낙서", ja: "落書き" });
    const base3 = composeTriggers("Draw.", { ko: "낙서", ja: "落書き", zh: "涂鸦" });
    expect(base3).toBe("Draw. | 落書き | 낙서 | 涂鸦"); // ja<ko<zh alphabetical order
    expect(base3.startsWith(base2.split(" | ")[0])).toBe(true); // base unchanged
  });
  it("composeTriggers: dedups whitespace tokens inside a language string, case-insensitive, and drops an empty language", () => {
    expect(composeTriggers("X.", { ko: "그리기 그리기  낙서", en: "" })).toBe("X. | 그리기 낙서");
  });

  it("catalogJson: description = composeTriggers(base, triggers)", () => {
    reg(TEST_PREFIX + "compose", {
      description: "Toggle the doodle overlay.",
      triggers: { ko: "낙서 그리기" },
    });
    const entry = catalogJson().find((c) => c.name === TEST_PREFIX + "compose");
    expect(entry?.description).toBe("Toggle the doodle overlay. | 낙서 그리기");
  });
});

describe("execute — service envelope seam (PS7, docs/PLUGIN-SERVICE.md)", () => {
  it("envelope:'service' keeps the envelope message and does not overwrite it with spec.message", async () => {
    reg(TEST_PREFIX + "svc.msg", {
      envelope: "service",
      message: () => "fallback label",
      handler: () => ({ ok: true, code: "OK", message: "sentence built by the service", data: { n: 1 } }),
    });
    const r = await execute(TEST_PREFIX + "svc.msg", {}, {});
    expect(r.ok).toBe(true);
    expect(r.message).toBe("sentence built by the service");
    expect(r.data).toEqual({ n: 1 });
  });

  it("falls back to spec.message when the envelope has no message — a degraded label, not a rejection (MESSAGE-PROTOCOL §3)", async () => {
    reg(TEST_PREFIX + "svc.nomsg", {
      envelope: "service",
      message: () => "fallback label",
      handler: () => ({ ok: true, code: "OK", data: { n: 2 } }),
    });
    const r = await execute(TEST_PREFIX + "svc.nomsg", {}, {});
    expect(r.message).toBe("fallback label");
  });

  it("maps envelope hints onto hint — capped at 3, shape checked, and kept out of data", async () => {
    reg(TEST_PREFIX + "svc.hints", {
      envelope: "service",
      handler: () => ({
        ok: true,
        message: "ok",
        data: { x: 1 },
        hints: [
          { cmd: "a", why: "1" },
          { cmd: "b", why: "2" },
          { cmd: "c", why: "3" },
          { cmd: "d", why: "4" },
        ],
      }),
    });
    const r = await execute(TEST_PREFIX + "svc.hints", {}, {});
    // A service (plugin) hint is built shape-only too, and the central point prefixes this app's CLI
    // name (unified contract).
    expect(r.hint).toEqual([
      { cmd: "sok a", why: "1" },
      { cmd: "sok b", why: "2" },
      { cmd: "sok c", why: "3" },
    ]);
    // hints does not leak into data (reserved key separation)
    expect(r.data).toEqual({ x: 1 });
  });

  it("keeps code, message, and hints from a failure envelope", async () => {
    reg(TEST_PREFIX + "svc.fail", {
      envelope: "service",
      handler: () => ({
        ok: false,
        code: "CONFLICT",
        message: "conflict",
        hints: [{ cmd: "retry", why: "run it again" }],
      }),
    });
    const r = await execute(TEST_PREFIX + "svc.fail", {}, {});
    expect(r).toMatchObject({ ok: false, code: "CONFLICT", message: "conflict" });
    expect(r.hint).toEqual([{ cmd: "sok retry", why: "run it again" }]);
  });

  it("keeps the plain spec rule — the handler message is dropped and spec.message owns the line (regression seal)", async () => {
    reg(TEST_PREFIX + "svc.plainkeep", {
      message: () => "sentence owned by the spec",
      handler: () => ({ message: "sentence from the handler", n: 3 }),
    });
    const r = await execute(TEST_PREFIX + "svc.plainkeep", {}, {});
    expect(r.message).toBe("sentence owned by the spec");
  });
});

describe("execute — trace sink (A1 activity hub)", () => {
  it("puts ok, source, danger, and paramKeys on the trace, with no sensitive value", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.ok", { params: { secretValue: { type: "string", description: "" } } });
      await execute("trace.ok", { secretValue: "s3cr3t" }, { remote: true });
      await execute("trace.missing", {}, { remote: false });

      expect(traces).toHaveLength(2);
      expect(traces[0]).toMatchObject({
        command: "trace.ok",
        source: "remote",
        ok: true,
        paramKeys: ["secretValue"],
      });
      // The value itself appears nowhere — key names only.
      expect(JSON.stringify(traces[0])).not.toContain("s3cr3t");
      expect(traces[1]).toMatchObject({
        command: "trace.missing",
        source: "ui",
        ok: false,
        code: "UNKNOWN_COMMAND",
      });
      expect(typeof traces[0].durationMs).toBe("number");
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("leaves the command result unaffected by a sink exception", async () => {
    setCommandTraceSink(() => {
      throw new Error("sink failure");
    });
    try {
      reg("trace.safe", {});
      const r = await execute("trace.safe", {}, { remote: false });
      expect(r.ok).toBe(true);
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("passes ctx.parent through to trace.parentId, and omits it when absent", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.parent", {});
      await execute("trace.parent", {}, { remote: true, parent: "turn-42" });
      await execute("trace.parent", {}, { remote: true });
      expect(traces[0].parentId).toBe("turn-42");
      expect(traces[1].parentId).toBeUndefined();
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("drops a system-origin call from speech and passes origin through (§5)", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.sys", { message: () => "seen", speak: () => "sentence to speak" });
      await execute("trace.sys", {}, { remote: true, origin: "schedule" });
      await execute("trace.sys", {}, { remote: true });
      expect(traces[0].origin).toBe("schedule");
      expect(traces[0].speak).toBeUndefined(); // system origin means silence regardless of the spec
      expect(traces[1].origin).toBeUndefined();
      expect(traces[1].speak).toBe("sentence to speak"); // human origin plus a speak declaration means speech
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("keeps a spec with trace:false out of the trace — the observation feedback block", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.silent", { trace: false });
      reg("trace.loud", {});
      const r = await execute("trace.silent", {}, { remote: true, parent: "turn-1" });
      await execute("trace.loud", {}, { remote: true });
      expect(r.ok).toBe(true); // execution itself is fine — only the trace is skipped
      expect(traces).toHaveLength(1);
      expect(traces[0].command).toBe("trace.loud");
    } finally {
      setCommandTraceSink(null);
    }
  });
});

describe("execute — common response fields (window, hint)", () => {
  it("puts window on every response, success and failure alike", async () => {
    reg(TEST_PREFIX + "win-ok", { handler: () => ({ v: 1 }) });
    const ok = await execute(TEST_PREFIX + "win-ok", {}, {});
    const bad = await execute(TEST_PREFIX + "win-missing", {}, {}); // unregistered — the failure path
    expect(ok).toHaveProperty("window");
    expect(bad).toHaveProperty("window");
    expect(typeof ok.window).toBe("string");
    expect(typeof bad.window).toBe("string");
  });

  it("truncates a success hint to 3", async () => {
    reg(TEST_PREFIX + "hint-many", {
      handler: () => ({}),
      hint: () => [
        { cmd: "a", why: "1" },
        { cmd: "b", why: "2" },
        { cmd: "c", why: "3" },
        { cmd: "d", why: "4" },
      ],
    });
    const r = await execute(TEST_PREFIX + "hint-many", {}, {});
    expect(r.ok).toBe(true);
    expect(r.hint).toHaveLength(3);
    // After truncating to 3, the central point prefixes this app's CLI name.
    expect(r.hint?.map((h) => h.cmd)).toEqual(["sok a", "sok b", "sok c"]);
  });

  it("builds a success hint from data and ctx", async () => {
    reg(TEST_PREFIX + "hint-data", {
      handler: () => ({ id: "x-seven" }),
      // The producer builds the command shape only — the central point adds this app's name as the
      // prefix.
      hint: (data) => [{ cmd: `open ${String(data.id)}`, why: "open it next" }],
    });
    const r = await execute(TEST_PREFIX + "hint-data", {}, {});
    expect(r.hint?.[0].cmd).toBe("sok open x-seven");
  });

  it("puts the standard hint on a TARGET_NOT_FOUND failure", async () => {
    reg(TEST_PREFIX + "nf", {
      handler: () => ({ ok: false, code: "TARGET_NOT_FOUND", message: "not found" }),
    });
    const r = await execute(TEST_PREFIX + "nf", {}, {});
    expect(r.ok).toBe(false);
    expect(r.hint).toHaveLength(1);
    expect(r.hint?.[0].cmd).toBe("sok state.tree");
    // why is a sentence resolved through tmsg — the actual phrase, not the key.
    expect(typeof r.hint?.[0].why).toBe("string");
    expect((r.hint?.[0].why ?? "").length).toBeGreaterThan(0);
    expect(r.hint?.[0].why).not.toBe("hint.error.targetNotFound");
  });

  it("gives no hint for an error code with no standard mapping", async () => {
    reg(TEST_PREFIX + "boom-hint", {
      handler: () => {
        throw new Error("x");
      },
    });
    const r = await execute(TEST_PREFIX + "boom-hint", {}, {}); // INTERNAL — no mapping
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(r.hint).toBeUndefined();
  });

  it("returns success when the hint function throws, omitting only the hint", async () => {
    reg(TEST_PREFIX + "hint-throw", {
      handler: () => ({ v: 1 }),
      hint: () => {
        throw new Error("hint blast");
      },
    });
    const r = await execute(TEST_PREFIX + "hint-throw", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ v: 1 });
    expect(r.hint).toBeUndefined();
  });

  it("puts danger in catalogJson only for a spec that declares it", () => {
    reg(TEST_PREFIX + "cat-danger", { danger: "destructive" });
    reg(TEST_PREFIX + "cat-safe", {});
    const danger = catalogJson().find((c) => c.name === TEST_PREFIX + "cat-danger");
    const safe = catalogJson().find((c) => c.name === TEST_PREFIX + "cat-safe");
    expect(danger?.danger).toBe("destructive");
    expect("danger" in (safe as object)).toBe(false);
  });
});

describe("UNKNOWN_COMMAND resolver injection point", () => {
  // The resolver is guidance for "no such name" — an empty registry is not a name problem, so the
  // resolver is not called. This block therefore measures against a non-empty registry.
  beforeEach(() => {
    register("resolver.fixture.present", {
      description: "fixture",
      params: {},
      returns: "void",
      message: () => "ok",
      handler: () => ({}),
    });
  });
  afterEach(() => {
    unregister("resolver.fixture.present");
  });

  it("prefers resolver hints over the standard hint and truncates them to 3", async () => {
    // The resolver builds the command shape only (same shape as the real resolver) — the central
    // point adds the prefix.
    setUnknownCommandResolver((name) => [
      { cmd: `plugin.install '{"source":"soksak-ai/${name}"}'`, why: "install it to use it" },
      { cmd: "b", why: "b" },
      { cmd: "c", why: "c" },
      { cmd: "d", why: "d" },
    ]);
    const r = await execute("plugin.soksak-plugin-missing.run", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
    expect(r.hint).toHaveLength(3);
    expect(r.hint?.[0].cmd).toContain("plugin.install");
    setUnknownCommandResolver(() => []);
  });

  it("falls back to the general discovery hint when the resolver is empty or throws", async () => {
    setUnknownCommandResolver(() => {
      throw new Error("boom");
    });
    const r = await execute("no-such-command", {}, {});
    expect(r.hint?.[0].cmd).toBe("sok commands");
    setUnknownCommandResolver(() => []);
  });
});

describe("base syntax — positional argument {_}", () => {
  it("maps the positional onto the single required parameter, with type conversion", async () => {
    register(TEST_PREFIX + "pos1", {
      description: "positional",
      params: {
        who: { type: "string", description: "", required: true },
        extra: { type: "string", description: "" },
      },
      returns: "{}",
      message: () => "",
      handler: (p) => ({ got: p.who }),
    });
    const r = await execute(TEST_PREFIX + "pos1", { _: "activity" }, {});
    expect(r).toMatchObject({ ok: true, data: { got: "activity" } });

    register(TEST_PREFIX + "pos2", {
      description: "positional number",
      params: { n: { type: "number", description: "", required: true } },
      returns: "{}",
      message: () => "",
      handler: (p) => ({ got: p.n }),
    });
    const r2 = await execute(TEST_PREFIX + "pos2", { _: "42" }, {});
    expect(r2).toMatchObject({ ok: true, data: { got: 42 } });
  });

  it("maps the positional onto a declared primary regardless of required, and omitting it still works", async () => {
    register(TEST_PREFIX + "pos4", {
      description: "primary positional",
      params: { name: { type: "string", description: "" }, project: { type: "string", description: "" } },
      returns: "{}",
      message: () => "",
      primary: "name",
      handler: (p) => ({ got: p.name ?? null }),
    });
    const r = await execute(TEST_PREFIX + "pos4", { _: "web" }, {});
    expect(r).toMatchObject({ ok: true, data: { got: "web" } });
    const r2 = await execute(TEST_PREFIX + "pos4", {}, {});
    expect(r2.ok).toBe(true);
  });

  it("gives INVALID_PARAMS with a help hint when two parameters are required", async () => {
    register(TEST_PREFIX + "pos3", {
      description: "two required",
      params: {
        a: { type: "string", description: "", required: true },
        b: { type: "string", description: "", required: true },
      },
      returns: "{}",
      message: () => "",
      handler: () => ({}),
    });
    const r = await execute(TEST_PREFIX + "pos3", { _: "x" }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
    expect(r.hint?.[0].cmd).toContain("sok help");
  });
});

