// semver 유틸 단위검증 — 의존 해석의 단일진실(dependencies·accept.minVersion 매칭).
// 소스(src/semver.ts)가 단일진실 — dist 는 산출물이라 테스트는 소스를 직접 겨눈다.
import { describe, expect, it } from "vitest";
import { semverCompare, semverGte, semverSatisfies } from "../src/semver.ts";

describe("semverCompare / semverGte", () => {
  it("major.minor.patch 순서 비교", () => {
    expect(semverCompare("2.0.0", "1.9.9")).toBe(1);
    expect(semverCompare("1.0.0", "1.0.0")).toBe(0);
    expect(semverCompare("1.0.1", "1.1.0")).toBe(-1);
    expect(semverGte("2.0.0", "2.0.0")).toBe(true);
    expect(semverGte("1.9.9", "2.0.0")).toBe(false);
  });
  it("형식 불량이면 null", () => {
    expect(semverCompare("x", "1.0.0")).toBeNull();
    expect(semverGte("1.0", "1.0.0")).toBeNull();
  });
});

describe("semverSatisfies — 기존 형식 회귀", () => {
  it("* 는 항상 참", () => expect(semverSatisfies("9.9.9", "*")).toBe(true));
  it("정확 일치", () => {
    expect(semverSatisfies("2.0.0", "2.0.0")).toBe(true);
    expect(semverSatisfies("2.0.1", "2.0.0")).toBe(false);
  });
  it(">= 하한", () => {
    expect(semverSatisfies("2.0.0", ">=2.0.0")).toBe(true);
    expect(semverSatisfies("1.9.9", ">=2.0.0")).toBe(false);
  });
  it("caret — 최상위 비-0 고정", () => {
    expect(semverSatisfies("1.5.0", "^1.0.0")).toBe(true);
    expect(semverSatisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(semverSatisfies("0.1.5", "^0.1.0")).toBe(true); // 0.x: minor 고정
    expect(semverSatisfies("0.2.0", "^0.1.0")).toBe(false);
  });
  it("tilde — minor 고정", () => {
    expect(semverSatisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(semverSatisfies("1.3.0", "~1.2.0")).toBe(false);
  });
});

describe("semverSatisfies — 복합 범위·비교연산자(사고 수정)", () => {
  it("복합 AND 범위 >=1.0.0 <2.0.0", () => {
    expect(semverSatisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(semverSatisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false); // 상한 미포함
    expect(semverSatisfies("0.9.0", ">=1.0.0 <2.0.0")).toBe(false); // 하한 미달
  });
  it("< > <= 연산자", () => {
    expect(semverSatisfies("1.0.0", "<2.0.0")).toBe(true);
    expect(semverSatisfies("2.0.0", "<2.0.0")).toBe(false);
    expect(semverSatisfies("2.0.1", ">2.0.0")).toBe(true);
    expect(semverSatisfies("2.0.0", ">2.0.0")).toBe(false);
    expect(semverSatisfies("2.0.0", "<=2.0.0")).toBe(true);
  });
  it("여백 여러 절도 AND", () => {
    expect(semverSatisfies("1.2.3", ">1.0.0 <=1.2.3 >=1.2.0")).toBe(true);
  });
  it("미인식 절이 하나라도 있으면 null(과잉통과 금지)", () => {
    expect(semverSatisfies("1.0.0", ">=1.0.0 || <0.1.0")).toBeNull(); // || 미지원
    expect(semverSatisfies("1.0.0", "1.x")).toBeNull();
  });
  it("버전 형식 불량이면 null", () => {
    expect(semverSatisfies("1.0", ">=1.0.0")).toBeNull();
  });
});
