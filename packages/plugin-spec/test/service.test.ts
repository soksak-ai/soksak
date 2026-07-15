// plugin service 매니페스트 검증 매트릭스 — docs/PLUGIN-SERVICE.md 의 PS 조항을 강제한다.
// PS3(커맨드 스펙=매니페스트 데이터·hello ops 대조 원천), PS4(entry:null 합법 조건),
// PS5/PS6(service.interface 계약 문법), PS14(contributes.schedules 데이터 선언).
// 소스(src/spec.ts)가 단일진실 — dist 는 산출물이라 테스트는 소스를 직접 겨눈다.
import { describe, expect, it } from "vitest";
import * as serviceSpecSurface from "../src/spec";
import {
  PERMISSION_INFO,
  PERMISSIONS,
  parseManifest,
  SERVICE_CONTRACT_REQUIREMENT,
  semverGte,
  semverSatisfies,
  serviceOps,
  SPEC_VERSION,
} from "../src/spec";

// 서비스 선언 유효 최소 매니페스트 — 각 테스트가 여기서 변형해 깨뜨린다(implements.test.ts 관례 동형).
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "데모",
    version: "0.0.1",
    description: "테스트용",
    entry: null,
    permissions: ["commands", "sidecar", "service"],
    sidecars: [{
      name: "demo-svc",
      interface: { id: "soksak-spec-sidecar-fixture-wire", range: ">=0.0.1 <1.0.0" },
    }],
    service: { sidecar: "demo-svc", interface: SERVICE_CONTRACT_REQUIREMENT },
    contributes: {
      commands: [
        {
          name: "run",
          title: { en: "Run", ko: "실행" },
          bind: "service",
          description: "Start a demo run.",
          params: { doc: { type: "string", description: "target doc", required: true } },
          returns: "object",
        },
      ],
    },
    ...overrides,
  };
}

function errorsOf(raw: unknown, dirName = "demo"): string[] {
  return parseManifest(raw, dirName).validation.errors;
}

describe("service — 수용(PS3·PS4)", () => {
  it("pins the first-party service requirement to the exact 0.0.1 contract", () => {
    expect(SERVICE_CONTRACT_REQUIREMENT).toEqual({
      id: "soksak-spec-service",
      range: "0.0.1",
    });
  });

  it("does not export a concatenated-interface alias", () => {
    expect(serviceSpecSurface).not.toHaveProperty("SERVICE_INTERFACE");
  });

  it("서비스 선언 + bind:service 커맨드 + entry:null 통과, 정규화 보존", () => {
    const { manifest, validation } = parseManifest(base(), "demo");
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(manifest?.entry).toBeNull();
    expect(manifest?.service).toEqual({
      sidecar: "demo-svc",
      interface: SERVICE_CONTRACT_REQUIREMENT,
      subscribe: [],
    });
    const cmd = manifest?.contributes.commands[0];
    expect(cmd?.bind).toBe("service");
    expect(cmd?.description).toBe("Start a demo run.");
    expect(cmd?.params?.doc.type).toBe("string");
    expect(cmd?.returns).toBe("object");
  });

  it("serviceOps — hello ops 대조의 단일 원천: bind:service 커맨드 이름의 정렬 집합(PS3)", () => {
    const { manifest } = parseManifest(
      base({
        contributes: {
          commands: [
            { name: "zeta", title: "Z", bind: "service", description: "Z op." },
            { name: "alpha", title: "A", bind: "service", description: "A op." },
          ],
        },
      }),
      "demo",
    );
    expect(manifest).not.toBeNull();
    expect(serviceOps(manifest!)).toEqual(["alpha", "zeta"]);
  });

  it("entry 있는 플러그인의 bind:service·JS 커맨드 혼재 통과(PS4 는 entry:null 조건일 뿐)", () => {
    const { manifest, validation } = parseManifest(
      base({
        entry: "main.js",
        contributes: {
          commands: [
            { name: "run", title: "Run", bind: "service", description: "Run op." },
            { name: "open", title: "Open" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(serviceOps(manifest!)).toEqual(["run"]);
  });

  it("subscribe — bus: 접두 토픽 배열 수용 + trim 정규화(PS15)", () => {
    const { manifest, validation } = parseManifest(
      base({
        service: {
          sidecar: "demo-svc",
          interface: SERVICE_CONTRACT_REQUIREMENT,
          subscribe: ["bus:kanban:changed"],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.service?.subscribe).toEqual(["bus:kanban:changed"]);
  });

  it("params 기본 {} · returns 기본 object — bind:service 에서 description 만 필수(PS3)", () => {
    const { manifest, validation } = parseManifest(
      base({
        contributes: {
          commands: [{ name: "run", title: "Run", bind: "service", description: "Run op." }],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.commands[0]?.params).toEqual({});
    expect(manifest?.contributes.commands[0]?.returns).toBe("object");
  });
});

describe("service — 거부(PS3·PS5·PS6)", () => {
  it("bind:service 커맨드가 있는데 service 블록 부재 → 거부(PS3)", () => {
    const errs = errorsOf(base({ service: undefined, entry: "main.js" }));
    expect(errs.some((e) => e.includes("bind"))).toBe(true);
  });

  it("bind 값이 service 외 → 거부", () => {
    const errs = errorsOf(
      base({
        contributes: {
          commands: [{ name: "run", title: "Run", bind: "webview", description: "x" }],
        },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("bind:service 인데 description 부재 → 거부(PS3 — 스펙 전문은 매니페스트 데이터)", () => {
    const errs = errorsOf(
      base({
        contributes: { commands: [{ name: "run", title: "Run", bind: "service" }] },
      }),
    );
    expect(errs.some((e) => e.includes("description"))).toBe(true);
  });

  it("bind 없는 커맨드의 params/description 선언 → 거부(스펙 데이터는 bind:service 전용)", () => {
    const errs = errorsOf(
      base({
        entry: "main.js",
        service: undefined,
        permissions: ["commands"],
        sidecars: undefined,
        contributes: {
          commands: [{ name: "open", title: "Open", description: "js command" }],
        },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("params 형식 위반(미지 type·description 부재·미지 키) → 거부", () => {
    for (const bad of [
      { doc: { type: "blob", description: "x" } },
      { doc: { type: "string" } },
      { doc: { type: "string", description: "x", surprise: 1 } },
    ]) {
      const errs = errorsOf(
        base({
          contributes: {
            commands: [
              { name: "run", title: "Run", bind: "service", description: "Run.", params: bad },
            ],
          },
        }),
      );
      expect(errs.length).toBeGreaterThan(0);
    }
  });

  it("service.interface 계약 문법 위반(-spec@ 부재·판 별칭) → 거부(PS6·NAMING §8)", () => {
    for (const iface of [
      "soksak-service@1",
      "soksak-spec-service@01",
      "soksak-spec-plugin-terminal@0.0.1",
      "Service-Spec@1",
    ]) {
      const errs = errorsOf(
        base({ service: { sidecar: "demo-svc", interface: iface } }),
      );
      expect(errs.some((e) => e.includes("interface"))).toBe(true);
    }
  });

  it("service.sidecar 가 sidecars[] 를 참조하지 않음 → 거부(PS9 — 배급은 사이드카 법 상속)", () => {
    const errs = errorsOf(
      base({ service: { sidecar: "ghost", interface: SERVICE_CONTRACT_REQUIREMENT } }),
    );
    expect(errs.some((e) => e.includes("sidecar"))).toBe(true);
  });

  it('service 선언에 "service" 권한 부재 → 거부(caution 동의 고지)', () => {
    const errs = errorsOf(base({ permissions: ["commands", "sidecar"] }));
    expect(errs.some((e) => e.includes("service"))).toBe(true);
  });

  it("service 선언인데 bind:service 커맨드 0개 → 거부(PS3 — 서비스는 커맨드를 소유한다)", () => {
    const errs = errorsOf(
      base({
        entry: "main.js",
        contributes: { commands: [{ name: "open", title: "Open" }] },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("service 블록 미지 키·subscribe 비 bus: 토픽 → 거부", () => {
    expect(
      errorsOf(
        base({
          service: { sidecar: "demo-svc", interface: SERVICE_CONTRACT_REQUIREMENT, extra: 1 },
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        base({
          service: {
            sidecar: "demo-svc",
            interface: SERVICE_CONTRACT_REQUIREMENT,
            subscribe: ["kanban:changed"],
          },
        }),
      ).some((e) => e.includes("subscribe")),
    ).toBe(true);
  });
});

describe("entry:null — 합법 조건(PS4)", () => {
  it("service 부재의 entry:null → 거부", () => {
    const errs = errorsOf(
      base({
        service: undefined,
        sidecars: undefined,
        permissions: ["commands"],
        contributes: { commands: [{ name: "open", title: "Open" }] },
      }),
    );
    expect(errs.some((e) => e.includes("entry"))).toBe(true);
  });

  it("entry:null 인데 bind 없는 커맨드 존재 → 거부(전 커맨드 bind:service 필수)", () => {
    const errs = errorsOf(
      base({
        contributes: {
          commands: [
            { name: "run", title: "Run", bind: "service", description: "Run." },
            { name: "open", title: "Open" },
          ],
        },
      }),
    );
    expect(errs.some((e) => e.includes("entry"))).toBe(true);
  });

  it("entry:null 인데 코드-필요 기여(views) 존재 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["commands", "sidecar", "service", "ui"],
        contributes: {
          views: [{ id: "panel", title: "Panel", icon: "★", status: [] }],
          commands: [{ name: "run", title: "Run", bind: "service", description: "Run." }],
          nodes: [{ id: "root" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("entry"))).toBe(true);
  });

  it("entry:null + 데이터만 기여(events·skill·configuration) → 통과", () => {
    const { validation } = parseManifest(
      base({
        configuration: [
          { key: "mode", type: "string", default: "fast", title: "Mode" },
        ],
        contributes: {
          commands: [{ name: "run", title: "Run", bind: "service", description: "Run." }],
          events: ["run.finished"],
          skill: { path: "skill/SKILL.md" },
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
  });
});

describe("contributes.schedules — 데이터 선언(PS14)", () => {
  const schedOk = {
    name: "reconcile",
    command: "run",
    trigger: { reconcile: true },
    timeoutMs: 1800000,
    zombieBackstopMs: 3600000,
  };

  it("reconcile·everyMs·cron 각 1변형 통과 + 정규화", () => {
    for (const trigger of [{ reconcile: true }, { everyMs: 60000 }, { cron: "0 * * * *" }]) {
      const { manifest, validation } = parseManifest(
        base({
          contributes: {
            commands: [{ name: "run", title: "Run", bind: "service", description: "Run." }],
            schedules: [{ ...schedOk, trigger }],
          },
        }),
        "demo",
      );
      expect(validation.errors).toEqual([]);
      expect(manifest?.contributes.schedules?.[0]?.trigger).toEqual(trigger);
    }
  });

  it("trigger 변형이 정확히 하나가 아니면 거부", () => {
    for (const trigger of [{}, { reconcile: true, cron: "* * * * *" }, { everyMs: 0 }, { reconcile: false }]) {
      const errs = errorsOf(
        base({
          contributes: {
            commands: [{ name: "run", title: "Run", bind: "service", description: "Run." }],
            schedules: [{ ...schedOk, trigger }],
          },
        }),
      );
      expect(errs.length).toBeGreaterThan(0);
    }
  });

  it("command 가 선언된 커맨드를 참조하지 않으면 거부", () => {
    const errs = errorsOf(
      base({
        contributes: {
          commands: [{ name: "run", title: "Run", bind: "service", description: "Run." }],
          schedules: [{ ...schedOk, command: "ghost" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("schedules"))).toBe(true);
  });

  it("service 선언 없는 schedules → 거부(수명 소유자 부재)", () => {
    const errs = errorsOf(
      base({
        entry: "main.js",
        service: undefined,
        sidecars: undefined,
        permissions: ["commands"],
        contributes: {
          commands: [{ name: "open", title: "Open" }],
          schedules: [{ ...schedOk, command: "open" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("schedules"))).toBe(true);
  });

  it("name 중복·형식 위반·timeoutMs 비양수 → 거부", () => {
    const cmds = [{ name: "run", title: "Run", bind: "service", description: "Run." }];
    expect(
      errorsOf(
        base({ contributes: { commands: cmds, schedules: [schedOk, schedOk] } }),
      ).some((e) => e.includes("중복")),
    ).toBe(true);
    expect(
      errorsOf(
        base({ contributes: { commands: cmds, schedules: [{ ...schedOk, name: "Bad Name" }] } }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(
        base({ contributes: { commands: cmds, schedules: [{ ...schedOk, timeoutMs: -1 }] } }),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("service 권한·semver 재수출(회귀 봉인)", () => {
  it('"service" 권한이 어휘·동의 고지(caution)에 존재', () => {
    expect(PERMISSIONS.includes("service" as (typeof PERMISSIONS)[number])).toBe(true);
    expect(PERMISSION_INFO["service" as keyof typeof PERMISSION_INFO]?.caution).toBe(true);
  });

  it("semver 유틸은 패키지 루트에서 계속 노출된다(모듈 추출 회귀 금지)", () => {
    expect(semverGte("1.2.3", "1.2.0")).toBe(true);
    expect(semverSatisfies("1.2.3", "^1.2.0")).toBe(true);
  });
});
