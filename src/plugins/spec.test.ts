// soksak-plugin-spec v1 검증 매트릭스 — all-or-nothing(§0-3) 계약 고정.
import { describe, expect, it } from "vitest";
import {
  parseManifest,
  pluginCommandName,
  resolveText,
  qualifiedViewId,
  semverGte,
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
      contributes: { views: [], commands: [], formatters: [], languages: [] },
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
        permissions: ["ui", "commands", "editor"],
        contributes: {
          views: [{ id: "v", title: "뷰", icon: "V", defaultPlacement: "sidebar-right" }],
          commands: [{ name: "do.it", title: "실행" }],
          formatters: [{ id: "f", title: "포맷", languages: ["json"] }],
          languages: [{ ext: "mjs", lang: "javascript" }],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
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

  it('formatters/languages 는 "editor" 권한 필요', () => {
    const errors = errorsOf(
      base({
        contributes: {
          formatters: [{ id: "f", title: "포맷", languages: ["json"] }],
          languages: [{ ext: "mjs", lang: "javascript" }],
        },
      }),
    );
    expect(errors.filter((e) => e.includes('"editor"'))).toHaveLength(2);
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

  it("포매터 languages 빈 배열/점 포함 확장자 → 거부", () => {
    for (const languages of [[], [".json"]]) {
      const errors = errorsOf(
        base({
          permissions: ["editor"],
          contributes: { formatters: [{ id: "f", title: "t", languages }] },
        }),
      );
      expect(errors.some((e) => e.includes("languages"))).toBe(true);
    }
  });

  it("languages ext 중복 → 거부", () => {
    const errors = errorsOf(
      base({
        permissions: ["editor"],
        contributes: {
          languages: [
            { ext: "mjs", lang: "javascript" },
            { ext: "mjs", lang: "typescript" },
          ],
        },
      }),
    );
    expect(errors.some((e) => e.includes("중복"))).toBe(true);
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
});

describe("parseManifest — programs 기여(§2.6)", () => {
  it("programs 는 'programs' 권한 필요", () => {
    const errs = errorsOf(
      base({
        contributes: { programs: [{ id: "claude", title: "Claude", kind: "terminal" }] },
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
            { id: "claude", title: "Claude", kind: "terminal", path: "에이전트" },
            { id: "exp", title: "실험", kind: "terminal", path: "에이전트/실험 채널" },
            { id: "web", title: "브라우저", kind: "browser" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs).toEqual([
      { id: "claude", title: "Claude", kind: "terminal", path: "에이전트" },
      { id: "exp", title: "실험", kind: "terminal", path: "에이전트/실험 채널" },
      { id: "web", title: "브라우저", kind: "browser" },
    ]);
  });

  it("path 빈 세그먼트 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [{ id: "a", title: "x", kind: "terminal", path: "에이전트//하위" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("path"))).toBe(true);
  });

  it("프로그램 id 형식 위반 → 거부", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "Bad_ID", title: "x", kind: "terminal" }] },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('내장 개념 없음 — "terminal" id 도 플러그인이 등록한다', () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "terminal", title: "터미널", kind: "terminal" }] },
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
            { id: "a", title: "x", kind: "terminal" },
            { id: "a", title: "y", kind: "terminal" },
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
              kind: "terminal",
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
