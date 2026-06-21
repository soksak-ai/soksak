import { describe, expect, it } from "vitest";
import {
  classifyHealth,
  accept,
  nextAction,
  reconcilePlan,
  parseProbeVersion,
  type Observed,
} from "./runtimeDep";
import type { LibraryDep } from "./spec";

// 관찰 → Health 5상태 분류(순수). "존재 == 작동" 폐기.
describe("classifyHealth — 관찰 상태 분류", () => {
  const base: Observed = {
    present: true,
    working: true,
    partial: false,
    broken: false,
  };
  it("partial(lib O·bin X) → PARTIAL (어제 EEXIST)", () =>
    expect(classifyHealth({ ...base, partial: true })).toBe("PARTIAL"));
  it("broken(dangling) → BROKEN", () =>
    expect(classifyHealth({ ...base, broken: true })).toBe("BROKEN"));
  it("부재 → ABSENT", () =>
    expect(classifyHealth({ ...base, present: false })).toBe("ABSENT"));
  it("존재하나 probe 실패 → BROKEN", () =>
    expect(classifyHealth({ ...base, working: false })).toBe("BROKEN"));
  it("버전 미달 → VERSION_MISMATCH", () =>
    expect(classifyHealth({ ...base, version: "1.0.0" }, "2.0.0")).toBe(
      "VERSION_MISMATCH",
    ));
  it("작동 + 버전 충족 → HEALTHY", () =>
    expect(classifyHealth({ ...base, version: "2.1.0" }, "2.0.0")).toBe(
      "HEALTHY",
    ));
  it("작동 + minVersion 없음 → HEALTHY", () =>
    expect(classifyHealth(base)).toBe("HEALTHY"));
});

describe("accept — HEALTHY 만 수용", () => {
  it("HEALTHY true, 그 외 false", () => {
    expect(accept("HEALTHY")).toBe(true);
    expect(accept("PARTIAL")).toBe(false);
    expect(accept("VERSION_MISMATCH")).toBe(false);
  });
});

describe("nextAction — 상태별 reconcile 액션(순수)", () => {
  it("HEALTHY=noop · ABSENT/VERSION_MISMATCH=reach · PARTIAL/BROKEN=cleanup-then-reach", () => {
    expect(nextAction("HEALTHY")).toBe("noop");
    expect(nextAction("ABSENT")).toBe("reach");
    expect(nextAction("VERSION_MISMATCH")).toBe("reach");
    expect(nextAction("PARTIAL")).toBe("cleanup-then-reach");
    expect(nextAction("BROKEN")).toBe("cleanup-then-reach");
  });
});

// parseProbeVersion — probe stdout → 버전 추출(순수). observe.versionRe 가 "actual" 버전을 뽑는다.
// versionRe 없으면 추출 불가(undefined) → accept.minVersion 비교 불가(classifyHealth 가 minVersion 무시).
describe("parseProbeVersion — probe stdout 버전 추출", () => {
  it("versionRe 없으면 undefined(추출 불가)", () => {
    expect(parseProbeVersion("v1.2.3", undefined)).toBeUndefined();
  });
  it("캡처그룹 1 우선", () => {
    expect(
      parseProbeVersion("gemini version 2.5.1 (abc)", "version (\\d+\\.\\d+\\.\\d+)"),
    ).toBe("2.5.1");
  });
  it("캡처그룹 없으면 전체 매치", () => {
    expect(parseProbeVersion("v1.2.3 build", "\\d+\\.\\d+\\.\\d+")).toBe("1.2.3");
  });
  it("미매치 → undefined", () => {
    expect(parseProbeVersion("no version here", "\\d+\\.\\d+\\.\\d+")).toBeUndefined();
  });
});

// reconcilePlan — dep + 관찰(Observed) → reconcile 단계(순수): action + reach 실행 종류.
// vendor/fetch reach 를 결정에 포함(command/install 만이 아니라 4-tuple 전체).
describe("reconcilePlan — action + reach 실행 결정", () => {
  const lib = (extra: Partial<LibraryDep> = {}): LibraryDep => ({
    name: "x",
    bin: "x",
    install: { darwin: "npm i -g x" },
    ...extra,
  });
  const obs = (extra: Partial<Observed> = {}): Observed => ({
    present: false,
    working: false,
    partial: false,
    broken: false,
    ...extra,
  });
  it("HEALTHY → noop", () => {
    expect(reconcilePlan(lib(), obs({ present: true, working: true }), "darwin")).toEqual({
      action: "noop",
    });
  });
  it("ABSENT → reach command(레거시 install)", () => {
    expect(reconcilePlan(lib(), obs(), "darwin")).toEqual({
      action: "reach",
      reach: { kind: "command", command: "npm i -g x" },
    });
  });
  it("PARTIAL → cleanup-then-reach", () => {
    expect(reconcilePlan(lib(), obs({ partial: true }), "darwin")).toEqual({
      action: "cleanup-then-reach",
      reach: { kind: "command", command: "npm i -g x" },
    });
  });
  it("reach.vendor → vendor 실행(path+sha256)", () => {
    expect(
      reconcilePlan(lib({ reach: { vendor: { path: "p", sha256: "h" } } }), obs(), "darwin"),
    ).toEqual({ action: "reach", reach: { kind: "vendor", vendorPath: "p", sha256: "h" } });
  });
  it("reach.fetch → fetch 실행(이 플랫폼 url+sha256)", () => {
    expect(
      reconcilePlan(
        lib({ reach: { fetch: { url: { darwin: "u" }, sha256: { darwin: "h" } } } }),
        obs(),
        "darwin",
      ),
    ).toEqual({ action: "reach", reach: { kind: "fetch", url: "u", sha256: "h" } });
  });
  it("이 플랫폼 공급 수단 없으면 noop", () => {
    expect(reconcilePlan(lib({ install: { linux: "apt" } }), obs(), "darwin")).toEqual({
      action: "noop",
    });
  });
});
