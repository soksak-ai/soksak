// soksak-plugin-spec v1 검증 매트릭스 — all-or-nothing(§0-3) 계약 고정.
import { describe, expect, it } from "vitest";
import {
  configDefaults,
  parseManifest,
  pluginCommandName,
  resolveText,
  qualifiedViewId,
  scanHostChromeViolations,
  semverGte,
  semverSatisfies,
  SPEC_VERSION,
} from "./spec";

// 유효한 최소 매니페스트 — 각 테스트가 여기서 변형해 깨뜨린다.
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "데모",
    version: "1.0.0",
    description: "테스트용",
    permissions: [],
    ...overrides,
  };
}

function errorsOf(raw: unknown, dirName = "demo"): string[] {
  return parseManifest(raw, dirName).validation.errors;
}

describe("parseManifest — 수용", () => {
  it("최소 매니페스트 통과 + 기본값 정규화(entry)", () => {
    const { manifest, validation } = parseManifest(base(), "demo");
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(manifest).toMatchObject({
      id: "demo",
      entry: "main.js",
      permissions: [],
      contributes: { views: [], commands: [] },
    });
  });

  it("뷰 기본 배치 정규화: placements=[sidebar-right], defaultPlacement=첫 항목", () => {
    const { manifest } = parseManifest(
      base({
        permissions: ["ui"],
        contributes: {
          views: [
            { id: "panel", title: "패널", icon: "P" },
            {
              id: "diff",
              title: "디프",
              icon: "D",
              placements: ["content", "sidebar-right"],
            },
          ],
        },
      }),
      "demo",
    );
    expect(manifest?.contributes.views[0]).toMatchObject({
      placements: ["sidebar-right"],
      defaultPlacement: "sidebar-right",
    });
    expect(manifest?.contributes.views[1]).toMatchObject({
      placements: ["content", "sidebar-right"],
      defaultPlacement: "content",
    });
  });

  it("전체 기여 + 권한 정합 매니페스트 통과", () => {
    const { validation } = parseManifest(
      base({
        author: "max",
        entry: "dist/main.js",
        minAppVersion: "0.1.0",
        permissions: ["ui", "commands"],
        contributes: {
          views: [{ id: "v", title: "뷰", icon: "V", defaultPlacement: "sidebar-right" }],
          commands: [{ name: "do.it", title: "실행" }],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
  });

  it("contributes.skill — { path } 선언 수용·보존(권한 불요)", () => {
    const { manifest, validation } = parseManifest(
      base({ contributes: { skill: { path: "skill/SKILL.md" } } }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.skill).toEqual({ path: "skill/SKILL.md" });
  });

  it("contributes.skill — 선언 없으면 skill 키 부재(하위호환)", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.skill).toBeUndefined();
  });

  it("contributes.skill.path — 절대경로·.. 탈출 거부", () => {
    expect(parseManifest(base({ contributes: { skill: { path: "/etc/x" } } }), "demo").validation.ok).toBe(false);
    expect(parseManifest(base({ contributes: { skill: { path: "../escape/SKILL.md" } } }), "demo").validation.ok).toBe(false);
    expect(parseManifest(base({ contributes: { skill: {} } }), "demo").validation.ok).toBe(false);
  });

  it("contributes.commands.danger — destructive|inject 수용, 매니페스트에 보존", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["commands", "commands:destructive"],
        contributes: {
          views: [],
          commands: [
            { name: "wipe", title: "지우기", danger: "destructive" },
            { name: "send", title: "보내기", danger: "inject" },
            { name: "list", title: "목록" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.commands).toMatchObject([
      { name: "wipe", danger: "destructive" },
      { name: "send", danger: "inject" },
      { name: "list" },
    ]);
    expect(manifest?.contributes.commands[2]).not.toHaveProperty("danger");
  });

  it("contributes.commands.danger — 알 수 없는 값은 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["commands"],
        contributes: {
          views: [],
          commands: [{ name: "x", title: "엑스", danger: "nuke" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("danger"))).toBe(true);
  });

  it("template:true 보존, 생략/false 는 미포함", () => {
    expect(parseManifest(base({ template: true }), "demo").manifest).toMatchObject(
      { template: true },
    );
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("template");
    expect(
      parseManifest(base({ template: false }), "demo").manifest,
    ).not.toHaveProperty("template");
  });

  it("repo(git URL) 수용 + 매니페스트에 보존", () => {
    const { manifest, validation } = parseManifest(
      base({ repo: "https://github.com/soksak-ai/soksak-plugin-shark.git" }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest).toMatchObject({
      repo: "https://github.com/soksak-ai/soksak-plugin-shark.git",
    });
  });
});

describe("parseManifest — fileViewers(A13)", () => {
  it("id+extensions(+optional priority, '*' 폴백) 수용, ui 권한이면 통과", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["ui"],
        contributes: {
          fileViewers: [
            { id: "code", extensions: ["ts", "*"], priority: 5 },
            { id: "img", extensions: ["png"] },
          ],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.fileViewers).toEqual([
      { id: "code", extensions: ["ts", "*"], priority: 5 },
      { id: "img", extensions: ["png"] },
    ]);
  });

  it("ui 권한 미선언이면 거부", () => {
    const errs = errorsOf(
      base({ contributes: { fileViewers: [{ id: "code", extensions: ["ts"] }] } }),
    );
    expect(errs.some((e) => e.includes('"ui" 권한'))).toBe(true);
  });

  it("빈 extensions / 잘못된 확장자 / 비-number priority 거부", () => {
    expect(
      errorsOf(base({ permissions: ["ui"], contributes: { fileViewers: [{ id: "a", extensions: [] }] } })).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(base({ permissions: ["ui"], contributes: { fileViewers: [{ id: "a", extensions: ["."] }] } })).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(base({ permissions: ["ui"], contributes: { fileViewers: [{ id: "a", extensions: ["ts"], priority: "hi" }] } })).length,
    ).toBeGreaterThan(0);
  });

  it("id 중복 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          fileViewers: [
            { id: "dup", extensions: ["ts"] },
            { id: "dup", extensions: ["js"] },
          ],
        },
      }),
    );
    expect(errs.some((e) => e.includes("fileViewers.id"))).toBe(true);
  });
});

describe("parseManifest — 거부(필수 필드)", () => {
  it("객체가 아니면 거부", () => {
    expect(parseManifest("문자열", "demo").manifest).toBeNull();
    expect(parseManifest(null, "demo").manifest).toBeNull();
    expect(parseManifest([], "demo").manifest).toBeNull();
  });

  it.each([
    ["spec 불일치", base({ spec: "soksak-plugin-spec@2" }), "spec"],
    ["id 형식 위반(대문자)", base({ id: "Demo" }), "id"],
    ["id 형식 위반(선행 하이픈)", base({ id: "-demo" }), "id"],
    ["name 누락", { ...base(), name: undefined }, "name"],
    ["version 비semver", base({ version: "1.0" }), "version"],
    ["description 누락", { ...base(), description: undefined }, "description"],
    ["author 비문자열", base({ author: 3 }), "author"],
    ["repo 비URL", base({ repo: "soksak-ai/shark" }), "repo"],
    ["minAppVersion 비semver", base({ minAppVersion: "v1" }), "minAppVersion"],
    ["template 비boolean", base({ template: "yes" }), "template"],
  ])("%s → 거부", (_label, raw, field) => {
    const errors = errorsOf(raw);
    expect(errors.some((e) => e.startsWith(field))).toBe(true);
    expect(parseManifest(raw, "demo").manifest).toBeNull();
  });

  it("id ≠ 설치 디렉토리명 → 거부", () => {
    const errors = errorsOf(base(), "other-dir");
    expect(errors.some((e) => e.includes("디렉토리명"))).toBe(true);
  });

  it("알 수 없는 최상위 키 → 거부(오타 조기 발견)", () => {
    expect(errorsOf(base({ permision: [] }))).toContainEqual(
      expect.stringContaining('"permision"'),
    );
  });
});

describe("parseManifest — entry 규율", () => {
  it.each([
    ["절대경로", "/etc/main.js"],
    ["윈도우 절대경로", "C:\\main.js"],
    ["디렉토리 탈출", "../evil/main.js"],
    ["중간 탈출", "dist/../../main.js"],
    ["비 ESM 확장자", "main.ts"],
  ])("%s → 거부", (_label, entry) => {
    expect(errorsOf(base({ entry })).some((e) => e.startsWith("entry"))).toBe(true);
  });

  it("디렉토리 내부 상대경로는 허용", () => {
    const { manifest } = parseManifest(base({ entry: "dist/bundle.mjs" }), "demo");
    expect(manifest?.entry).toBe("dist/bundle.mjs");
  });
});

describe("parseManifest — 권한", () => {
  it("permissions 누락 → 거부(빈 배열은 명시해야 함)", () => {
    const raw = base();
    delete (raw as Record<string, unknown>).permissions;
    expect(errorsOf(raw).some((e) => e.startsWith("permissions"))).toBe(true);
  });

  it("알 수 없는 권한 → 거부", () => {
    expect(
      errorsOf(base({ permissions: ["ui", "root"] })).some((e) =>
        e.includes('"root"'),
      ),
    ).toBe(true);
  });

  it("권한 중복 → 거부", () => {
    expect(
      errorsOf(base({ permissions: ["ui", "ui"] })).some((e) => e.includes("중복")),
    ).toBe(true);
  });
});

describe("parseManifest — 권한-기여 정합성", () => {
  it('views 는 "ui" 권한 필요', () => {
    const errors = errorsOf(
      base({ contributes: { views: [{ id: "v", title: "뷰", icon: "V" }] } }),
    );
    expect(errors.some((e) => e.includes('"ui"'))).toBe(true);
  });

  it('commands 는 "commands" 권한 필요', () => {
    const errors = errorsOf(
      base({ contributes: { commands: [{ name: "go", title: "고" }] } }),
    );
    expect(errors.some((e) => e.includes('"commands"'))).toBe(true);
  });

});

describe("parseManifest — contributes.events(발행 토픽, 정보용)", () => {
  it("유효 토픽 배열 수용(권한 불요)", () => {
    const { manifest, validation } = parseManifest(
      base({ contributes: { events: ["mailbox.message", "mailbox.read"] } }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.events).toEqual(["mailbox.message", "mailbox.read"]);
  });
  it("선언 없으면 빈 배열 기본", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.events).toEqual([]);
  });
  it("불량 토픽(형식/비문자열)·중복 → 거부", () => {
    expect(errorsOf(base({ contributes: { events: ["Bad Topic"] } })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ contributes: { events: [123] } })).length).toBeGreaterThan(0);
    expect(
      errorsOf(base({ contributes: { events: ["a.b", "a.b"] } })).some((e) => e.includes("중복")),
    ).toBe(true);
  });
});

describe("parseManifest — 기여 항목 검증", () => {
  it("뷰 id 중복 → 거부", () => {
    const errors = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          views: [
            { id: "v", title: "1", icon: "A" },
            { id: "v", title: "2", icon: "B" },
          ],
        },
      }),
    );
    expect(errors.some((e) => e.includes("중복"))).toBe(true);
  });

  it("뷰 placements 불량(빈 배열/미지 값) → 거부", () => {
    for (const placements of [[], ["left"]]) {
      const errors = errorsOf(
        base({
          permissions: ["ui"],
          contributes: { views: [{ id: "v", title: "뷰", icon: "V", placements }] },
        }),
      );
      expect(errors.some((e) => e.includes("placements"))).toBe(true);
    }
  });

  it("defaultPlacement 가 placements 밖 → 거부", () => {
    const errors = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          views: [
            {
              id: "v",
              title: "뷰",
              icon: "V",
              placements: ["sidebar-right"],
              defaultPlacement: "content",
            },
          ],
        },
      }),
    );
    expect(errors.some((e) => e.includes("defaultPlacement"))).toBe(true);
  });

  it("뷰 항목의 알 수 없는 키 → 거부", () => {
    const errors = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          views: [{ id: "v", title: "뷰", icon: "V", placment: ["content"] }],
        },
      }),
    );
    expect(errors.some((e) => e.includes('"placment"'))).toBe(true);
  });

  it("명령 이름 형식 위반 → 거부", () => {
    for (const name of ["Do", "do..it", ".go", "go."]) {
      const errors = errorsOf(
        base({
          permissions: ["commands"],
          contributes: { commands: [{ name, title: "t" }] },
        }),
      );
      expect(errors.some((e) => e.includes("contributes.commands"))).toBe(true);
    }
  });

});

describe("parseManifest — all-or-nothing(§0-3)", () => {
  it("에러가 여러 영역에 걸치면 전부 수집하고 manifest 는 null", () => {
    const { manifest, validation } = parseManifest(
      base({
        version: "x",
        entry: "../e.js",
        permissions: ["bogus"],
        contributes: { views: [{ id: "v", title: "뷰", icon: "V" }] },
      }),
      "demo",
    );
    expect(manifest).toBeNull();
    expect(validation.ok).toBe(false);
    // version + entry + 권한 + ui 정합 = 최소 4개 사유.
    expect(validation.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("이름 규칙·semver 헬퍼", () => {
  it("전역 키 규칙", () => {
    expect(qualifiedViewId("memo", "panel")).toBe("memo.panel");
    expect(pluginCommandName("memo", "clear")).toBe("plugin.memo.clear");
  });

  it("semverGte", () => {
    expect(semverGte("1.2.3", "1.2.3")).toBe(true);
    expect(semverGte("1.10.0", "1.9.9")).toBe(true);
    expect(semverGte("0.9.0", "1.0.0")).toBe(false);
    expect(semverGte("1.0.0-beta", "1.0.0")).toBe(true); // pre-release 무시(v1 정책)
    expect(semverGte("abc", "1.0.0")).toBeNull();
  });

  it("semverSatisfies — * / 정확", () => {
    expect(semverSatisfies("9.9.9", "*")).toBe(true);
    expect(semverSatisfies("1.2.3", "1.2.3")).toBe(true);
    expect(semverSatisfies("1.2.4", "1.2.3")).toBe(false);
  });
  it("semverSatisfies — caret(^) npm 의미론", () => {
    expect(semverSatisfies("1.5.0", "^1.2.3")).toBe(true);
    expect(semverSatisfies("2.0.0", "^1.2.3")).toBe(false); // major 상한
    expect(semverSatisfies("1.2.2", "^1.2.3")).toBe(false); // 하한 미만
    // ^0.x — minor 잠금
    expect(semverSatisfies("0.1.9", "^0.1.0")).toBe(true);
    expect(semverSatisfies("0.2.0", "^0.1.0")).toBe(false);
    // ^0.0.z — patch 잠금
    expect(semverSatisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(semverSatisfies("0.0.4", "^0.0.3")).toBe(false);
  });
  it("semverSatisfies — tilde(~)/comparator(>=)", () => {
    expect(semverSatisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(semverSatisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(semverSatisfies("2.0.0", ">=1.0.0")).toBe(true);
    expect(semverSatisfies("0.9.0", ">=1.0.0")).toBe(false);
  });
  it("semverSatisfies — 형식 불량은 null", () => {
    expect(semverSatisfies("abc", "^1.0.0")).toBeNull();
    expect(semverSatisfies("1.0.0", "garbage")).toBeNull();
  });
});

describe("parseManifest — dependencies(플러그인↔플러그인 의존)", () => {
  it("유효한 dependencies 수용 + 정규화", () => {
    const { manifest, validation } = parseManifest(
      base({ dependencies: { "soksak-plugin-acp-core": "^0.1.0" } }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.dependencies).toEqual({ "soksak-plugin-acp-core": "^0.1.0" });
  });
  it("dependencies 없으면 키 자체가 없음(선택)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("dependencies");
  });
  it("자기 자신 의존 거부", () => {
    expect(errorsOf(base({ dependencies: { demo: "^1.0.0" } }))).toContain(
      'dependencies: 자기 자신("demo") 의존 금지',
    );
  });
  it("잘못된 키/범위 거부(all-or-nothing)", () => {
    expect(parseManifest(base({ dependencies: { "Bad_Id": "^1.0.0" } }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ dependencies: { dep: "latest" } }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ dependencies: [] }), "demo").manifest).toBeNull();
  });
});

describe("parseManifest — libraries(외부 CLI 종속성)", () => {
  const lib = {
    name: "@google/gemini-cli",
    bin: "gemini",
    install: { darwin: "npm i -g @google/gemini-cli@latest" },
    label: "Gemini CLI",
  };
  it("유효한 libraries 수용 + 정규화", () => {
    const { manifest, validation } = parseManifest(base({ libraries: [lib] }), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.libraries).toEqual([lib]);
  });
  it("libraries 없으면 키 자체가 없음(선택)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("libraries");
  });
  it("name/bin 누락 거부(all-or-nothing)", () => {
    expect(parseManifest(base({ libraries: [{ bin: "gemini", install: { darwin: "x" } }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ libraries: [{ name: "x", install: { darwin: "x" } }] }), "demo").manifest).toBeNull();
  });
  it("install 플랫폼 키/빈 객체 거부", () => {
    expect(parseManifest(base({ libraries: [{ name: "x", bin: "x", install: { bad: "y" } }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ libraries: [{ name: "x", bin: "x", install: {} }] }), "demo").manifest).toBeNull();
  });
  it("bin 중복 거부", () => {
    const dup = { name: "a", bin: "gemini", install: { darwin: "x" } };
    expect(parseManifest(base({ libraries: [dup, dup] }), "demo").manifest).toBeNull();
  });
  it("libraries 배열 아니면 거부", () => {
    expect(parseManifest(base({ libraries: {} }), "demo").manifest).toBeNull();
  });

  // 4-tuple(observe/accept/reach) — 선택. 선언 시 형식 검증, 미선언이면 레거시 동작.
  const ok4 = (extra: object): boolean =>
    parseManifest(base({ libraries: [{ ...lib, ...extra }] }), "demo").validation.ok;
  it("observe.probe 배열 유효 / 비배열·빈배열 거부", () => {
    expect(ok4({ observe: { probe: ["gemini", "--version"] } })).toBe(true);
    expect(ok4({ observe: { probe: "gemini" } })).toBe(false);
    expect(ok4({ observe: { probe: [] } })).toBe(false);
  });
  it("accept.minVersion semver 유효 / 비semver 거부", () => {
    expect(ok4({ accept: { minVersion: "1.2.3" } })).toBe(true);
    expect(ok4({ accept: { minVersion: "latest" } })).toBe(false);
  });
  it("reach vendor 는 path+sha256 필수", () => {
    expect(ok4({ reach: { vendor: { path: "bin/gemini", sha256: "abc" } } })).toBe(true);
    expect(ok4({ reach: { vendor: { path: "bin/gemini" } } })).toBe(false);
  });
  it("reach fetch/command 플랫폼별 유효", () => {
    expect(
      ok4({ reach: { fetch: { url: { darwin: "https://x" }, sha256: { darwin: "h" } } } }),
    ).toBe(true);
    expect(ok4({ reach: { command: { darwin: "npm i -g x" } } })).toBe(true);
  });
  it("reach 는 정확히 하나 variant(0개·2개 거부)", () => {
    expect(ok4({ reach: {} })).toBe(false);
    expect(
      ok4({ reach: { vendor: { path: "p", sha256: "h" }, command: { darwin: "c" } } }),
    ).toBe(false);
  });
});

describe("parseManifest — configuration(설정 스키마)", () => {
  const cfg = [
    { key: "defaultAgent", type: "enum", enum: ["claude", "codex", "gemini"], default: "claude", title: "기본 에이전트" },
    { key: "maxRounds", type: "number", default: 5, min: 1, max: 20, title: "합의 상한" },
    { key: "showGuestbook", type: "boolean", default: true, title: "방명록" },
  ];
  it("유효한 configuration 수용 + 정규화", () => {
    const { manifest, validation } = parseManifest(base({ configuration: cfg }), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.configuration).toEqual(cfg);
  });
  it("없으면 키 자체가 없음(선택)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("configuration");
  });
  it("enum default 가 enum 밖이면 거부", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "enum", enum: ["x", "y"], default: "z", title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("type 과 default 불일치 거부", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "number", default: "5", title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "boolean", default: 1, title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("enum 누락 / 비-enum 의 enum 거부", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "enum", default: "x", title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "string", enum: ["x"], default: "x", title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("min>max / min·max 는 number 전용 거부", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "number", default: 5, min: 10, max: 1, title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "string", default: "x", min: 1, title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("key 형식·중복 거부", () => {
    expect(parseManifest(base({ configuration: [{ key: "1bad", type: "boolean", default: true, title: "t" }] }), "demo").manifest).toBeNull();
    const dup = { key: "a", type: "boolean", default: true, title: "t" };
    expect(parseManifest(base({ configuration: [dup, dup] }), "demo").manifest).toBeNull();
  });
  it("configDefaults 기본값 맵", () => {
    const { manifest } = parseManifest(base({ configuration: cfg }), "demo");
    expect(configDefaults(manifest!)).toEqual({ defaultAgent: "claude", maxRounds: 5, showGuestbook: true });
  });
});

describe("parseManifest — DOM 노출 노드(contributes.nodes)", () => {
  it("nodes 는 'ui' 권한 필요", () => {
    const errs = errorsOf(
      base({ contributes: { nodes: [{ id: "submit", description: "전송" }] } }),
    );
    expect(errs.some((e) => e.includes('contributes.nodes: "ui" 권한'))).toBe(true);
  });
  it("ui 권한 있으면 수용 + 파싱", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["ui"],
        contributes: {
          nodes: [
            { id: "submit", description: { ko: "전송 버튼", en: "Submit" } },
            { id: "msg", description: "메시지 행" },
            { id: "danger-node", danger: true },
          ],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.nodes.map((n) => n.id)).toEqual(["submit", "msg", "danger-node"]);
    expect(manifest?.contributes.nodes[2].danger).toBe(true);
  });
  it("id 정규식 위반 거부", () => {
    const errs = errorsOf(base({ permissions: ["ui"], contributes: { nodes: [{ id: "Bad-Id" }] } }));
    expect(errs.some((e) => e.includes("contributes.nodes: id"))).toBe(true);
  });
  it("중복 id 거부", () => {
    const errs = errorsOf(
      base({ permissions: ["ui"], contributes: { nodes: [{ id: "x" }, { id: "x" }] } }),
    );
    expect(errs.some((e) => e.includes("contributes.nodes.id"))).toBe(true);
  });
  it("danger 는 true 만 허용", () => {
    const errs = errorsOf(
      base({ permissions: ["ui"], contributes: { nodes: [{ id: "x", danger: false }] } }),
    );
    expect(errs.some((e) => e.includes("danger: true 만"))).toBe(true);
  });
  it("nodes 없으면 빈 배열(기본)", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.nodes).toEqual([]);
  });
});

describe("parseManifest — programs 기여(§2.6)", () => {
  it("programs 는 'programs' 권한 필요", () => {
    const errs = errorsOf(
      base({
        contributes: { programs: [{ id: "claude", title: "Claude", kind: "view", view: "content" }] },
      }),
    );
    expect(errs.some((e) => e.includes('"programs" 권한'))).toBe(true);
  });

  it("유효한 programs 기여 통과 + path 다단 카테고리", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            { id: "claude", title: "Claude", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal", command: "claude", path: "에이전트" },
            { id: "exp", title: "실험", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal", path: "에이전트/실험 채널" },
            { id: "web", title: "뷰", kind: "view", view: "content" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs).toEqual([
      { id: "claude", title: "Claude", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal", command: "claude", path: "에이전트" },
      { id: "exp", title: "실험", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal", path: "에이전트/실험 채널" },
      { id: "web", title: "뷰", kind: "view", view: "content" },
    ]);
  });

  it("kind 는 view 만 허용(terminal 수렴 — 코어 터미널 제거)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "claude", title: "Claude", kind: "terminal", command: "claude" }] },
      }),
    );
    expect(errs.some((e) => e.includes("kind"))).toBe(true);
  });

  it("kind=view 는 view(뷰 id) 필수", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "a", title: "x", kind: "view" }] },
      }),
    );
    expect(errs.some((e) => e.includes("view"))).toBe(true);
  });

  it("viewPlugin 은 플러그인 id 형식(크로스 플러그인 뷰 참조)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "a", title: "x", kind: "view", view: "content", viewPlugin: "Bad_ID" }] },
      }),
    );
    expect(errs.some((e) => e.includes("viewPlugin"))).toBe(true);
  });

  it("command/ensure 는 kind=view 에서 자동실행/설치로 동반 가능(에이전트 프로그램)", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            {
              id: "claude",
              title: "Claude",
              kind: "view",
              view: "content",
              viewPlugin: "soksak-plugin-terminal",
              command: "claude",
              ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
            },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs[0]).toMatchObject({
      command: "claude",
      ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
    });
  });

  it("path 빈 세그먼트 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [{ id: "a", title: "x", kind: "view", view: "content", path: "에이전트//하위" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("path"))).toBe(true);
  });

  it("프로그램 id 형식 위반 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "Bad_ID", title: "x", kind: "view", view: "content" }] },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('내장 개념 없음 — "terminal" id 도 플러그인이 등록한다', () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "terminal", title: "터미널", kind: "view", view: "content" }] },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs[0].id).toBe("terminal");
  });

  it("프로그램 id 중복 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            { id: "a", title: "x", kind: "view", view: "content" },
            { id: "a", title: "y", kind: "view", view: "content" },
          ],
        },
      }),
    );
    expect(errs.some((e) => e.includes("중복"))).toBe(true);
  });
});

describe("LocalizedText — 플러그인 텍스트 다국어(§3.5)", () => {
  it("string 단일형은 그대로 유효(후방호환)", () => {
    const { validation } = parseManifest(base(), "demo");
    expect(validation.ok).toBe(true);
  });

  it("name/description/기여 title 에 언어 맵 수용", () => {
    const { manifest, validation } = parseManifest(
      base({
        name: { ko: "터미널", en: "Terminal" },
        description: { ko: "설명", en: "Description" },
        permissions: ["programs"],
        contributes: {
          programs: [
            {
              id: "t",
              title: { ko: "터미널", en: "Terminal" },
              path: { ko: "에이전트", en: "Agents" },
              kind: "view",
              view: "content",
            },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.name).toEqual({ ko: "터미널", en: "Terminal" });
  });

  it("빈 맵/빈 값/불량 언어 키 → 거부", () => {
    expect(errorsOf(base({ name: {} })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ name: { ko: " " } })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ name: { KOREAN: "x" } })).length).toBeGreaterThan(0);
  });

  it("resolveText: 현재 언어 → 첫 선언 폴백", () => {
    expect(resolveText("터미널", "en")).toBe("터미널");
    expect(resolveText({ ko: "터미널", en: "Terminal" }, "en")).toBe("Terminal");
    expect(resolveText({ ko: "터미널", en: "Terminal" }, "ja")).toBe("터미널");
  });
});

describe("scanHostChromeViolations — 호스트 크롬 표준 정적 게이트", () => {
  it("자기 클래스만 스타일링하면 통과(위반 0)", () => {
    const ok = `.club-feed{height:100%}.st-tab{padding:3px}.acpc-bar{display:flex}`;
    expect(scanHostChromeViolations(ok)).toEqual([]);
  });
  it("호스트 탭 셀렉터 height 오버라이드는 위반", () => {
    expect(scanHostChromeViolations(`.left-host-tab{height:50px}`)).toContain(".left-host-tab");
    expect(scanHostChromeViolations(`.content-tabs{height:60px}`)).toContain(".content-tabs");
    expect(scanHostChromeViolations(`.view-tabs{padding:0}`)).toContain(".view-tabs");
  });
  it("호스트 크롬 변수 대입은 위반", () => {
    expect(scanHostChromeViolations(`:root{--chrome-row-h:99px}`)).toContain("--chrome-row-h");
    expect(scanHostChromeViolations(`.x{--header-h:10px}`)).toContain("--header-h");
  });
  it("주석·산문 언급은 오탐 아님(위반 0)", () => {
    expect(scanHostChromeViolations(`// .left-host-tabs 는 호스트가 소유한다`)).toEqual([]);
    expect(scanHostChromeViolations(`const note = "do not touch --chrome-row-h here"`)).toEqual([]);
  });
  it("여러 위반을 모두 보고", () => {
    const bad = `.left-host-tabs{height:40px} .ft-header{height:40px} :root{--header-h:5px}`;
    const v = scanHostChromeViolations(bad);
    expect(v).toEqual(expect.arrayContaining([".left-host-tabs", ".ft-header", "--header-h"]));
  });
});

describe("parseManifest — sidecars(engine 모듈 의존 선언)", () => {
  const sc = { name: "chromium", interface: "soksak-sidecar-browser@1" };
  it("유효한 sidecars 수용(sidecar 권한 동반)", () => {
    const { manifest, validation } = parseManifest(
      base({ permissions: ["sidecar"], sidecars: [sc] }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.sidecars).toEqual([sc]);
  });
  it("sidecars 없으면 키 자체가 없음(선택)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("sidecars");
  });
  it("sidecar 권한 없이 sidecars 선언 = 거부", () => {
    const { manifest, validation } = parseManifest(base({ sidecars: [sc] }), "demo");
    expect(manifest).toBeNull();
    expect(validation.errors.join()).toContain('"sidecar" 권한');
  });
  it("name 형식 위반 거부(경로 traversal 가드)", () => {
    for (const name of ["../evil", "Upper", "a/b", ""]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ name, interface: "x@1" }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
  it("interface 형식 위반 거부(id@major 필수)", () => {
    for (const iface of ["no-version", "x@", "x@abc", "@1"]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ name: "ok", interface: iface }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
  it("중복 name 거부", () => {
    expect(
      parseManifest(
        base({ permissions: ["sidecar"], sidecars: [sc, { ...sc, interface: "other@2" }] }),
        "demo",
      ).manifest,
    ).toBeNull();
  });
  it("미지 키 거부(all-or-nothing)", () => {
    expect(
      parseManifest(
        base({ permissions: ["sidecar"], sidecars: [{ ...sc, extra: 1 }] }),
        "demo",
      ).manifest,
    ).toBeNull();
  });
  it("reach.fetch(플랫폼 url+sha256) 수용", () => {
    const reach = { fetch: { url: { darwin: "https://x/a.tar.gz" }, sha256: { darwin: "ab12" } } };
    const { manifest, validation } = parseManifest(
      base({ permissions: ["sidecar"], sidecars: [{ ...sc, reach }] }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.sidecars?.[0].reach).toEqual(reach);
  });
  it("reach 는 fetch 전용 — command/vendor 거부", () => {
    for (const reach of [
      { command: { darwin: "brew install x" } },
      { vendor: { path: "v/x", sha256: "ab" } },
      { fetch: { url: { darwin: "u" }, sha256: { darwin: "s" } }, command: {} },
    ]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ ...sc, reach }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
});
