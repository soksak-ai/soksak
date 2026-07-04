// Command Registry 계약 테스트 — 검증 매트릭스·ok 래핑·권한 게이트·등록/해제.
// registry 는 모듈 전역 상태이므로 각 테스트는 자신이 등록한 명령을 정리한다.
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogJson,
  composeTriggers,
  execute,
  getSpec,
  register,
  setPermissionGate,
  unregister,
  type CommandSpec,
  setCommandTraceSink,
  type CommandTrace,
} from "./registry";

const TEST_PREFIX = "test.";
const registered: string[] = [];

function reg(name: string, spec: Partial<CommandSpec>): void {
  register(name, {
    description: "테스트 명령",
    params: {},
    returns: "테스트",
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
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { value: 7 } });
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
    expect(await execute(TEST_PREFIX + "enum", { mode: "a" }, {})).toEqual({ ok: true, code: "OK", message: "OK", data: { mode: "a" } });
  });

  it("json 타입은 임의 값 통과(핸들러 책임)", async () => {
    reg(TEST_PREFIX + "json", {
      params: { v: { type: "json", description: "" } },
      handler: (p) => ({ got: p.v }),
    });
    const r = await execute(TEST_PREFIX + "json", { v: { deep: [1] } }, {});
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { got: { deep: [1] } } });
  });

  it("default 는 미지정 시 채워지고 지정 시 유지", async () => {
    reg(TEST_PREFIX + "def", {
      params: { n: { type: "number", description: "", default: 10 } },
      handler: (p) => ({ n: p.n }),
    });
    expect(await execute(TEST_PREFIX + "def", {}, {})).toEqual({ ok: true, code: "OK", message: "OK", data: { n: 10 } });
    expect(await execute(TEST_PREFIX + "def", { n: 3 }, {})).toEqual({ ok: true, code: "OK", message: "OK", data: { n: 3 } });
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
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { did: true } });
  });

  it("게이트 허용 시 remote danger 도 실행", async () => {
    reg(TEST_PREFIX + "danger3", { danger: "destructive", handler: () => ({ did: true }) });
    setPermissionGate(() => true);
    const r = await execute(TEST_PREFIX + "danger3", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { did: true } });
  });

  it("danger 미분류 명령은 게이트와 무관", async () => {
    reg(TEST_PREFIX + "safe", { handler: () => ({ did: true }) });
    setPermissionGate(() => false);
    const r = await execute(TEST_PREFIX + "safe", {}, { remote: true });
    expect(r).toEqual({ ok: true, code: "OK", message: "OK", data: { did: true } });
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
});
