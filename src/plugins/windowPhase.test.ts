// @ts-nocheck — 대상은 vanilla 플러그인(plugins/soksak-plugin-window/main.js). tsc 는 건너뛰고
// vitest(esbuild)로만 실행한다. named export(phaseForTime/nextTransitionMs)는 로더가 무시
// (loader.ts default 만 사용)하므로 플러그인 동작 불변 — 테스트 전용 노출.
//
// 재현 RED → 구현 → GREEN. 시간대 경계와 "다음 전환까지 ms"(폴링 대신 setTimeout 1개의 근거)를
// 순수 함수로 고정한다. 경계(현지 시각): day 07:00 / sunset 17:00 / dusk 18:30 / night 20:00.

import { describe, it, expect } from "vitest";
import {
  phaseForTime,
  nextTransitionMs,
} from "../../plugins/soksak-plugin-window/main.js";

// 로컬 시각 Date — phaseForTime 은 getHours/getMinutes(로컬) 기준.
const at = (h, m, s = 0) => new Date(2026, 5, 16, h, m, s);

describe("phaseForTime — 시간대 경계(경계 분 포함)", () => {
  it.each([
    ["06:59", at(6, 59), "night"],
    ["07:00", at(7, 0), "day"],
    ["16:59", at(16, 59), "day"],
    ["17:00", at(17, 0), "sunset"],
    ["18:29", at(18, 29), "sunset"],
    ["18:30", at(18, 30), "dusk"],
    ["19:59", at(19, 59), "dusk"],
    ["20:00", at(20, 0), "night"],
    ["23:30", at(23, 30), "night"],
    ["00:00", at(0, 0), "night"],
  ])("%s → %s", (_label, date, expected) => {
    expect(phaseForTime(date)).toBe(expected);
  });
});

describe("nextTransitionMs — 다음 경계까지 ms(분/초 정밀)", () => {
  const MIN = 60_000;
  it("07:00 → 다음 17:00 (600분)", () => {
    expect(nextTransitionMs(at(7, 0))).toBe(600 * MIN);
  });
  it("06:00 → 다음 07:00 (60분)", () => {
    expect(nextTransitionMs(at(6, 0))).toBe(60 * MIN);
  });
  it("18:00 → 다음 18:30 (30분)", () => {
    expect(nextTransitionMs(at(18, 0))).toBe(30 * MIN);
  });
  it("20:00 → 익일 07:00 (660분, 자정 넘김)", () => {
    expect(nextTransitionMs(at(20, 0))).toBe(660 * MIN);
  });
  it("초 정밀: 16:59:30 → 17:00:00 (30초)", () => {
    expect(nextTransitionMs(at(16, 59, 30))).toBe(30_000);
  });
});
