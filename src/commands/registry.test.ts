// Command Registry 계약 테스트 — 검증 매트릭스·ok 래핑·권한 게이트·등록/해제.
// registry 는 모듈 전역 상태이므로 각 테스트는 자신이 등록한 명령을 정리한다.
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogJson,
  composeTriggers,
  effectiveSpeak,
  execute,
  getSpec,
  register,
  setPermissionGate,
  unregister,
  type CommandSpec,
  type CommandOutcome,
  setCommandTraceSink,
  setUnknownCommandResolver,
  type CommandTrace,
} from "./registry";

const TEST_PREFIX = "test.";
const registered: string[] = [];

function reg(name: string, spec: Partial<CommandSpec>): void {
  register(name, {
    description: "테스트 명령",
    params: {},
    returns: "테스트",
    message: () => "완료",
    handler: () => ({}),
    ...spec,
  });
  registered.push(name);
}

afterEach(() => {
  for (const name of registered.splice(0)) unregister(name);
  setPermissionGate(() => true);
});

describe("execute — 기본 계약", () => {
  it("미지 명령은 UNKNOWN_COMMAND", async () => {
    const r = await execute(TEST_PREFIX + "nope", {}, {});
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  it("핸들러 일반 객체 반환은 ok:true 로 래핑", async () => {
    reg(TEST_PREFIX + "plain", { handler: () => ({ value: 7 }) });
    const r = await execute(TEST_PREFIX + "plain", {}, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "완료", data: { value: 7 }, window: "" });
  });

  it("핸들러의 CmdResult({ok:false}) 는 그대로 통과", async () => {
    reg(TEST_PREFIX + "err", {
      handler: () => ({ ok: false, code: "TARGET_NOT_FOUND", message: "없음" }),
    });
    const r = await execute(TEST_PREFIX + "err", {}, {});
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });

  it("핸들러 throw 는 INTERNAL 로 변환 — 호스트는 죽지 않는다", async () => {
    reg(TEST_PREFIX + "boom", {
      handler: () => {
        throw new Error("폭발");
      },
    });
    const r = await execute(TEST_PREFIX + "boom", {}, {});
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
    expect((r as { message: string }).message).toContain("폭발");
  });

  it("async 핸들러 reject 도 INTERNAL", async () => {
    reg(TEST_PREFIX + "reject", {
      handler: async () => {
        throw new Error("비동기 실패");
      },
    });
    const r = await execute(TEST_PREFIX + "reject", {}, {});
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
  });
});

describe("낭독 축 — 표시(message)/낭독(speak) 둘뿐(§3)", () => {
  const spec = (speak?: (out: CommandOutcome) => string): CommandSpec =>
    ({ description: "d", params: {}, returns: "r", message: () => "완료", handler: () => ({}), ...(speak ? { speak } : {}) }) as CommandSpec;
  const out = (message: string, ok = true): CommandOutcome =>
    ({ ok, code: ok ? "OK" : "INTERNAL", message }) as CommandOutcome;

  it("speak 없음 = 침묵(낭독 opt-in — message 폴백 없음)", () => {
    expect(effectiveSpeak(spec(), out("완료"))).toBeUndefined();
  });
  it("speak 있음 = 성공·실패 불문 speak(outcome)가 문장 — 경로는 message(표시)에만", () => {
    const s = spec((o) => (o.ok ? "화면을 저장했어요." : o.message));
    expect(effectiveSpeak(s, out("저장했습니다: /tmp/a.png"))).toBe("화면을 저장했어요.");
    expect(effectiveSpeak(s, out("실패 진단", false))).toBe("실패 진단");
  });
  it('speak "" = 침묵 — say 류 되먹임의 유일한 차단점', () => {
    expect(effectiveSpeak(spec(() => ""), out("무엇이든"))).toBeUndefined();
  });
  it('execute 계측(trace) tts 는 speak 선언 명령만(낭독 opt-in)', async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    reg("test.tts-on", { message: () => "본다", speak: () => "읽는다", handler: () => ({}) });
    reg("test.tts-off", { message: () => "본다", handler: () => ({}) }); // speak 없음 = 침묵(opt-in)
    await execute("test.tts-on", {}, { remote: false });
    await execute("test.tts-off", {}, { remote: false });
    setCommandTraceSink(null);
    expect(traces.find((t) => t.command.endsWith("tts-on"))?.speak).toBe("읽는다");
    expect(traces.find((t) => t.command.endsWith("tts-off"))?.speak).toBeUndefined();
  });
});

describe("execute — 파라미터 검증 매트릭스", () => {
  it("선언 안 된 파라미터는 거부(오타 조기 발견)", async () => {
    reg(TEST_PREFIX + "strict", { params: {} });
    const r = await execute(TEST_PREFIX + "strict", { typo: 1 }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("필수 파라미터 누락 거부", async () => {
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
  ] as const)("타입 불일치 거부: %s", async (type, bad) => {
    const name = TEST_PREFIX + "type-" + type;
    reg(name, { params: { v: { type, description: "" } } });
    const r = await execute(name, { v: bad }, {});
    expect(r).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("enum 위반 거부, enum 일치 허용", async () => {
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
    expect(await execute(TEST_PREFIX + "enum", { mode: "a" }, {})).toEqual({ ok: true, code: "OK", message: "완료", data: { mode: "a" }, window: "" });
  });

  it("json 타입은 임의 값 통과(핸들러 책임)", async () => {
    reg(TEST_PREFIX + "json", {
      params: { v: { type: "json", description: "" } },
      handler: (p) => ({ got: p.v }),
    });
    const r = await execute(TEST_PREFIX + "json", { v: { deep: [1] } }, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "완료", data: { got: { deep: [1] } }, window: "" });
  });

  it("default 는 미지정 시 채워지고 지정 시 유지", async () => {
    reg(TEST_PREFIX + "def", {
      params: { n: { type: "number", description: "", default: 10 } },
      handler: (p) => ({ n: p.n }),
    });
    expect(await execute(TEST_PREFIX + "def", {}, {})).toEqual({ ok: true, code: "OK", message: "완료", data: { n: 10 }, window: "" });
    expect(await execute(TEST_PREFIX + "def", { n: 3 }, {})).toEqual({ ok: true, code: "OK", message: "완료", data: { n: 3 }, window: "" });
  });
});

describe("execute — 권한 게이트", () => {
  it("remote + danger + 게이트 거부 → PERMISSION_DENIED", async () => {
    reg(TEST_PREFIX + "danger", { danger: "destructive", handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "danger", {}, { remote: true });
    expect(r).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("UI(비원격) 호출은 게이트 면제 — 사람은 신뢰", async () => {
    reg(TEST_PREFIX + "danger2", { danger: "inject", handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "danger2", {}, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "완료", data: { did: true }, window: "" });
  });

  it("게이트 허용 시 remote danger 도 실행", async () => {
    reg(TEST_PREFIX + "danger3", { danger: "destructive", handler: () => ({ did: true }) });
    setPermissionGate(() => true);
    const r = await execute(TEST_PREFIX + "danger3", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "완료", data: { did: true }, window: "" });
  });

  it("danger 미분류 명령은 게이트와 무관", async () => {
    reg(TEST_PREFIX + "safe", { handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "safe", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "완료", data: { did: true }, window: "" });
  });
});

describe("register / unregister — 플러그인 생명주기 기반", () => {
  it("unregister 후 실행은 UNKNOWN_COMMAND, getSpec 은 undefined", async () => {
    reg(TEST_PREFIX + "gone", {});
    expect(getSpec(TEST_PREFIX + "gone")).toBeDefined();
    expect(unregister(TEST_PREFIX + "gone")).toBe(true);
    expect(getSpec(TEST_PREFIX + "gone")).toBeUndefined();
    const r = await execute(TEST_PREFIX + "gone", {}, {});
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });

  it("미등록 이름 unregister 는 false", () => {
    expect(unregister(TEST_PREFIX + "never-registered")).toBe(false);
  });

  it("catalogJson 은 unregister 된 명령을 포함하지 않는다", () => {
    reg(TEST_PREFIX + "cat", {});
    expect(catalogJson().some((c) => c.name === TEST_PREFIX + "cat")).toBe(true);
    unregister(TEST_PREFIX + "cat");
    expect(catalogJson().some((c) => c.name === TEST_PREFIX + "cat")).toBe(false);
  });

  it("catalogJson 은 이름순 정렬 + 핸들러 비포함(직렬화 가능)", () => {
    reg(TEST_PREFIX + "z-last", {});
    reg(TEST_PREFIX + "a-first", {});
    const names = catalogJson().map((c) => c.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const entry = catalogJson().find((c) => c.name === TEST_PREFIX + "a-first");
    expect(entry).toBeDefined();
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect("handler" in (entry as object)).toBe(false);
  });

  // composeTriggers — LLM 발견 표면(결정 8): 영어 base + 전 언어 트리거어 합성. 로케일 사본 아님.
  it("composeTriggers: triggers 없으면 base 그대로(하위호환)", () => {
    expect(composeTriggers("Split the panel.")).toBe("Split the panel.");
    expect(composeTriggers("Split the panel.", undefined)).toBe("Split the panel.");
    expect(composeTriggers("Split the panel.", {})).toBe("Split the panel.");
  });
  it("composeTriggers: base + ' | ' + 언어별 트리거어(라벨 없음)", () => {
    expect(composeTriggers("Split the panel.", { ko: "패널 나누기 분할" })).toBe(
      "Split the panel. | 패널 나누기 분할",
    );
  });
  it("composeTriggers: 언어코드 알파벳 정렬(결정적·대화언어 무관)", () => {
    // ko·ja → 정렬하면 ja 먼저(j<k). 입력 순서 무관.
    const out = composeTriggers("Draw.", { ko: "낙서 그리기", ja: "落書き 描く" });
    expect(out).toBe("Draw. | 落書き 描く | 낙서 그리기");
    // 입력 순서를 바꿔도 같은 결과(결정성).
    expect(composeTriggers("Draw.", { ja: "落書き 描く", ko: "낙서 그리기" })).toBe(out);
  });
  it("composeTriggers: 새 언어(zh) 추가 = 그 데이터만 합성에 반영, 나머지 불변", () => {
    const base2 = composeTriggers("Draw.", { ko: "낙서", ja: "落書き" });
    const base3 = composeTriggers("Draw.", { ko: "낙서", ja: "落書き", zh: "涂鸦" });
    expect(base3).toBe("Draw. | 落書き | 낙서 | 涂鸦"); // ja<ko<zh 알파벳 정렬
    expect(base3.startsWith(base2.split(" | ")[0])).toBe(true); // base 불변
  });
  it("composeTriggers: 언어 문자열 내 공백토큰 dedup(케이스무시) + 빈 언어 제거", () => {
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

describe("execute — 계측 sink (A1 활동 허브)", () => {
  it("성공·실패·출처·danger·paramKeys 가 trace 로 흐른다(민감값 미포함)", async () => {
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
      // 값 자체는 어디에도 없다 — 키 목록만.
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

  it("sink 예외는 명령 결과에 영향을 주지 않는다", async () => {
    setCommandTraceSink(() => {
      throw new Error("sink 고장");
    });
    try {
      reg("trace.safe", {});
      const r = await execute("trace.safe", {}, { remote: false });
      expect(r.ok).toBe(true);
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("ctx.parent 가 trace.parentId 로 관통한다(상관 스펙) — 없으면 미포함", async () => {
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

  it("시스템 유래(ctx.origin)는 낭독 후보에서 제외되고 origin 이 관통한다(§5)", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.sys", { message: () => "본다", speak: () => "읽을 문장" });
      await execute("trace.sys", {}, { remote: true, origin: "schedule" });
      await execute("trace.sys", {}, { remote: true });
      expect(traces[0].origin).toBe("schedule");
      expect(traces[0].speak).toBeUndefined(); // 시스템 유래 = 스펙과 무관하게 침묵
      expect(traces[1].origin).toBeUndefined();
      expect(traces[1].speak).toBe("읽을 문장"); // 사람 유래 + speak 선언 = 낭독
    } finally {
      setCommandTraceSink(null);
    }
  });

  it("spec trace:false 는 계측에서 제외된다(관찰 되먹임 차단 선언)", async () => {
    const traces: CommandTrace[] = [];
    setCommandTraceSink((t) => traces.push(t));
    try {
      reg("trace.silent", { trace: false });
      reg("trace.loud", {});
      const r = await execute("trace.silent", {}, { remote: true, parent: "turn-1" });
      await execute("trace.loud", {}, { remote: true });
      expect(r.ok).toBe(true); // 실행 자체는 정상 — 계측만 제외
      expect(traces).toHaveLength(1);
      expect(traces[0].command).toBe("trace.loud");
    } finally {
      setCommandTraceSink(null);
    }
  });
});

describe("execute — 응답 공통 필드(window·hint)", () => {
  it("모든 응답에 window 가 실린다(성공·실패)", async () => {
    reg(TEST_PREFIX + "win-ok", { handler: () => ({ v: 1 }) });
    const ok = await execute(TEST_PREFIX + "win-ok", {}, {});
    const bad = await execute(TEST_PREFIX + "win-missing", {}, {}); // 미등록 = 실패 경로
    expect(ok).toHaveProperty("window");
    expect(bad).toHaveProperty("window");
    expect(typeof ok.window).toBe("string");
    expect(typeof bad.window).toBe("string");
  });

  it("성공 hint 는 최대 3개로 잘린다", async () => {
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
    expect(r.hint?.map((h) => h.cmd)).toEqual(["a", "b", "c"]);
  });

  it("성공 hint 는 data·ctx 를 받아 제시를 짓는다", async () => {
    reg(TEST_PREFIX + "hint-data", {
      handler: () => ({ id: "x7" }),
      hint: (data) => [{ cmd: `sok open ${String(data.id)}`, why: "이어서 열 수 있습니다" }],
    });
    const r = await execute(TEST_PREFIX + "hint-data", {}, {});
    expect(r.hint?.[0].cmd).toBe("sok open x7");
  });

  it("TARGET_NOT_FOUND 실패 응답에 표준 hint 가 실린다", async () => {
    reg(TEST_PREFIX + "nf", {
      handler: () => ({ ok: false, code: "TARGET_NOT_FOUND", message: "없음" }),
    });
    const r = await execute(TEST_PREFIX + "nf", {}, {});
    expect(r.ok).toBe(false);
    expect(r.hint).toHaveLength(1);
    expect(r.hint?.[0].cmd).toBe("sok state.tree");
    // why 는 tmsg 로 해소된 문장 — 키가 아니라 실제 문구가 실린다.
    expect(typeof r.hint?.[0].why).toBe("string");
    expect((r.hint?.[0].why ?? "").length).toBeGreaterThan(0);
    expect(r.hint?.[0].why).not.toBe("hint.error.targetNotFound");
  });

  it("표준 매핑 없는 오류 코드는 hint 가 없다(과잉 안내 금지)", async () => {
    reg(TEST_PREFIX + "boom-hint", {
      handler: () => {
        throw new Error("x");
      },
    });
    const r = await execute(TEST_PREFIX + "boom-hint", {}, {}); // INTERNAL — 매핑 없음
    expect(r).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(r.hint).toBeUndefined();
  });

  it("hint 함수가 예외를 일으켜도 응답은 성공으로 온다(hint 만 생략)", async () => {
    reg(TEST_PREFIX + "hint-throw", {
      handler: () => ({ v: 1 }),
      hint: () => {
        throw new Error("hint 폭발");
      },
    });
    const r = await execute(TEST_PREFIX + "hint-throw", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ v: 1 });
    expect(r.hint).toBeUndefined();
  });

  it("catalogJson 은 danger 를 선언된 스펙에만 싣는다", () => {
    reg(TEST_PREFIX + "cat-danger", { danger: "destructive" });
    reg(TEST_PREFIX + "cat-safe", {});
    const danger = catalogJson().find((c) => c.name === TEST_PREFIX + "cat-danger");
    const safe = catalogJson().find((c) => c.name === TEST_PREFIX + "cat-safe");
    expect(danger?.danger).toBe("destructive");
    expect("danger" in (safe as object)).toBe(false);
  });
});

describe("UNKNOWN_COMMAND 지능형 해석기 주입점", () => {
  it("해석기가 결과를 주면 그 안내가 표준 안내보다 우선하고, 상한 3개로 잘린다", async () => {
    setUnknownCommandResolver((name) => [
      { cmd: `sok plugin.install '{"source":"soksak-ai/${name}"}'`, why: "설치하면 사용할 수 있습니다" },
      { cmd: "b", why: "b" },
      { cmd: "c", why: "c" },
      { cmd: "d", why: "d" },
    ]);
    const r = await execute("plugin.soksak-plugin-없는것.run", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
    expect(r.hint).toHaveLength(3);
    expect(r.hint?.[0].cmd).toContain("plugin.install");
    setUnknownCommandResolver(() => []);
  });

  it("해석기가 비어 있거나 예외를 일으키면 일반 탐색 안내로 돌아간다", async () => {
    setUnknownCommandResolver(() => {
      throw new Error("boom");
    });
    const r = await execute("정말없는명령", {}, {});
    expect(r.hint?.[0].cmd).toBe("sok commands");
    setUnknownCommandResolver(() => []);
  });
});

describe("기본형 문법 — 위치 인자 {_} 해석", () => {
  it("필수 매개변수가 하나면 그 이름으로 옮긴다(형 변환 포함)", async () => {
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

  it("primary 선언이 있으면 필수 여부와 무관하게 그 이름으로 옮긴다(생략=전부 문법 공존)", async () => {
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

  it("필수 매개변수가 둘이면 그대로 INVALID_PARAMS(도움말 hint)", async () => {
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

