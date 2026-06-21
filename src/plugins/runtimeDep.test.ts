import { describe, expect, it } from "vitest";
import {
  classifyHealth,
  accept,
  nextAction,
  reconcileNeeds,
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

// reconcileNeeds — present 집합(observe 결과) → 미충족 dep 의 reach 명령(순수). M3: command/install.
describe("reconcileNeeds — 미충족 dep 의 reach 명령", () => {
  const lib = (extra: Partial<LibraryDep> = {}): LibraryDep => ({
    name: "x",
    bin: "x",
    install: { darwin: "npm i -g x" },
    ...extra,
  });
  it("미설치(present X) → install 명령", () => {
    expect(reconcileNeeds([lib()], new Set(), "darwin")).toEqual(["npm i -g x"]);
  });
  it("설치됨(present O, minVersion 없음) → 빈 배열(noop)", () => {
    expect(reconcileNeeds([lib()], new Set(["x"]), "darwin")).toEqual([]);
  });
  it("reach.command 가 레거시 install 보다 우선", () => {
    expect(
      reconcileNeeds(
        [lib({ reach: { command: { darwin: "brew install x" } } })],
        new Set(),
        "darwin",
      ),
    ).toEqual(["brew install x"]);
  });
  it("이 플랫폼 명령 없으면 제외", () => {
    expect(
      reconcileNeeds([lib({ install: { linux: "apt install x" } })], new Set(), "darwin"),
    ).toEqual([]);
  });
});
