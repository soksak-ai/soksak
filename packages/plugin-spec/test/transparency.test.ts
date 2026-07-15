// C2 정적 투명성 — status 선언 축(M1) + 판정 순수함수(M2) + validate CLI 보고(M3).
// 판정 단일진실은 이 패키지(src/transparency.ts) — 코어·게이트·CLI 는 소비자다(미러 금지).
// 소스(src/*.ts)가 단일진실이라 판정 테스트는 소스를 직접 겨눈다. CLI 테스트만 빌드물
// (bin/validate.mjs → dist)을 스폰한다 — make spec-gate 가 빌드를 선행한다.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, SPEC_VERSION } from "../src/spec";
import {
  C2_STATIC_ENFORCEMENT,
  isContentView,
  transparencyViolations,
} from "../src/transparency";

// ── M1: contributes.views[].status 파싱 ──────────────────────────────────────

function base(views: unknown[]): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "데모",
    version: "1.0.0",
    description: "테스트용",
    permissions: ["ui", "commands"],
    contributes: {
      views,
      commands: [{ name: "open", title: "열기" }],
      nodes: [{ id: "root" }],
    },
  };
}

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "canvas", title: "캔버스", icon: "▣", placements: ["content"], ...overrides };
}

describe("contributes.views[].status — 선언 축 파싱(M1)", () => {
  it("상태 코드 배열 선언 → 그대로 정규화", () => {
    const { manifest, validation } = parseManifest(
      base([view({ status: ["dirty", "busy", "running"] })]),
      "demo",
    );
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(manifest?.contributes.views[0].status).toEqual(["dirty", "busy", "running"]);
  });

  it("빈 배열 = 무상태 명시 — 빈 배열 그대로 보존(선언 부재와 구분)", () => {
    const { manifest, validation } = parseManifest(base([view({ status: [] })]), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.views[0].status).toEqual([]);
  });

  it("선언 부재 → 파싱 거부가 아니라 status 부재로 보존(위반 판정은 C2 의 몫)", () => {
    const { manifest, validation } = parseManifest(base([view()]), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.views[0].status).toBeUndefined();
  });

  it("배열이 아니면 거부", () => {
    const { validation } = parseManifest(base([view({ status: "dirty" })]), "demo");
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("status");
  });

  it("비문자열·코드 형식 위반 항목 거부", () => {
    const { validation } = parseManifest(base([view({ status: ["Not A Code"] })]), "demo");
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("status");
    const { validation: v2 } = parseManifest(base([view({ status: [7] })]), "demo");
    expect(v2.ok).toBe(false);
  });

  it("중복 코드 거부", () => {
    const { validation } = parseManifest(base([view({ status: ["dirty", "dirty"] })]), "demo");
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("중복");
  });
});

// ── M2: 판정 순수함수 — 매니페스트 데이터만 받는다(런타임 증거 불요) ───────────

// 판정 입력 헬퍼 — contributes 형태(실물 선언 배열).
function contributes(overrides: Record<string, unknown> = {}) {
  return {
    views: [] as { id: string; placements: string[]; status?: string[] }[],
    overlays: [] as unknown[],
    commands: [] as unknown[],
    fileViewers: [] as unknown[],
    programs: [] as unknown[],
    nodes: [] as unknown[],
    ...overrides,
  };
}

describe("isContentView — 콘텐츠 뷰 판별(설치본 실측 정의: placements 에 content 포함)", () => {
  it("content 단독 배치 → 콘텐츠 뷰", () => {
    expect(isContentView({ placements: ["content"] })).toBe(true);
  });
  it("혼합 배치(sidebar-right+content) → 콘텐츠 뷰(git-diff 형)", () => {
    expect(isContentView({ placements: ["sidebar-right", "content"] })).toBe(true);
  });
  it("사이드바 전용 → 콘텐츠 뷰 아님", () => {
    expect(isContentView({ placements: ["sidebar-left", "sidebar-right"] })).toBe(false);
  });
});

describe("transparencyViolations — C2 정적 3규칙(M2)", () => {
  it("views>0 ∧ commands=0 → command-surface", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "c", placements: ["content"], status: [] }],
        nodes: [{ id: "root" }],
      }),
    );
    expect(v.map((x) => x.rule)).toEqual(["command-surface"]);
  });

  it("programs·fileViewers·overlays 만 기여해도 기능 보유 — commands=0 이면 command-surface", () => {
    expect(
      transparencyViolations(contributes({ programs: [{}] })).map((x) => x.rule),
    ).toEqual(["command-surface"]);
    expect(
      transparencyViolations(contributes({ fileViewers: [{}, {}] })).map((x) => x.rule),
    ).toEqual(["command-surface"]);
    expect(
      transparencyViolations(contributes({ overlays: [{}] })).map((x) => x.rule),
    ).toEqual(["command-surface", "view-nodes"]);
  });

  it("views>0 ∧ nodes=0 → view-nodes", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "c", placements: ["content"], status: [] }],
        commands: [{}],
      }),
    );
    expect(v.map((x) => x.rule)).toEqual(["view-nodes"]);
  });

  it("콘텐츠 뷰 status 선언 부재 → content-view-status(뷰 id 를 지목)", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "canvas", placements: ["content"] }],
        commands: [{}],
        nodes: [{ id: "root" }],
      }),
    );
    expect(v.map((x) => x.rule)).toEqual(["content-view-status"]);
    expect(v[0].detail).toContain("canvas");
  });

  it("빈 배열 선언 = 무상태 명시 → 위반 아님(침묵과 구분)", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "canvas", placements: ["content"], status: [] }],
        commands: [{}],
        nodes: [{ id: "root" }],
      }),
    );
    expect(v).toEqual([]);
  });

  it("사이드바 전용 뷰는 status 의무 밖(setStatus no-op — 규칙 스코프는 콘텐츠 뷰)", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "panel", placements: ["sidebar-right"] }],
        commands: [{}],
        nodes: [{ id: "root" }],
      }),
    );
    expect(v).toEqual([]);
  });

  it("혼합 배치 뷰도 콘텐츠 뷰 — status 부재면 위반", () => {
    const v = transparencyViolations(
      contributes({
        views: [{ id: "view", placements: ["sidebar-right", "content"] }],
        commands: [{}],
        nodes: [{ id: "root" }],
      }),
    );
    expect(v.map((x) => x.rule)).toEqual(["content-view-status"]);
  });

  it("복수 위반 동시 보고(은폐 0)", () => {
    const v = transparencyViolations(
      contributes({ views: [{ id: "c", placements: ["content"] }] }),
    );
    expect(v.map((x) => x.rule)).toEqual([
      "command-surface",
      "view-nodes",
      "content-view-status",
    ]);
  });

  it("기여 0 이면 위반 없음(아이콘셋·테마류)", () => {
    expect(transparencyViolations(contributes())).toEqual([]);
  });
});

describe("C2_STATIC_ENFORCEMENT — 현행 입법표 핀", () => {
  it("정적 3종 전부 blocking — content-view-status 는 선언 sweep 완료(위반 0 실측) 후 승격", () => {
    expect(C2_STATIC_ENFORCEMENT).toEqual({
      "command-surface": "blocking",
      "view-nodes": "blocking",
      "content-view-status": "blocking",
    });
  });
});

// ── M3: validate CLI — 문법 오류와 구분되는 투명성 섹션(저자 경계) ─────────────

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "bin", "validate.mjs");

function runValidate(fixture: string): { status: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    [CLI, join(PKG, "test", "fixtures", fixture, "plugin.json")],
    { encoding: "utf8" },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("validate CLI — C2 판정 보고(M3)", () => {
  it("c2-clean: 통과 + C2 출력 없음", () => {
    const r = runValidate("c2-clean");
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("C2");
  });

  it("c2-status-undeclared: content-view-status 는 blocking 승격분 — exit 1 로 거부", () => {
    const r = runValidate("c2-status-undeclared");
    expect(r.status).toBe(1);
    expect(r.out).toContain("content-view-status");
  });

  it("c2-static-violation: blocking 규칙 위반은 문법 오류와 구분된 섹션으로 exit 1", () => {
    const r = runValidate("c2-static-violation");
    expect(r.status).toBe(1);
    expect(r.out).toContain("command-surface");
    expect(r.out).toContain("view-nodes");
    expect(r.out).toContain("C2");
  });

  it("invalid-status: status 문법 위반은 파싱 거부(중복·코드 형식 — 알 수 없는 키가 아니라)", () => {
    const r = runValidate("invalid-status");
    expect(r.status).toBe(1);
    expect(r.out).toContain("status");
    expect(r.out).toContain("중복");
    expect(r.out).not.toContain('알 수 없는 키 "status"');
  });
});
