// 예산 게이트 자체 검증(M3 RED→GREEN) — 게이트가 위반을 놓치면 회귀 감지망 전체가 무효라
// 게이트를 먼저 검증한다: 위반 픽스처 → 위반 열거(exit 1 경로), 통과 픽스처 → 위반 0.
// 러너는 vitest 하나(vitest.config.ts scripts/**/*.test.mjs — 검사 메커니즘을 늘리지 않는다).
// 실행: pnpm vitest run scripts/perf/check-budgets.test.mjs (make perf-gate 가 실측 전 선행)
import { test } from "vitest";
import assert from "node:assert/strict";
import { checkBudgets } from "./check-budgets.mjs";

const budgets = {
  budgets: {
    "t1_plain.mbps": { min: 10 },
    "t1_plain.cpu.avg": { max: 120 },
    "t2.medianMs": { max: 20 },
    "t2.p95Ms": { max: 40 },
    "t5_idle.cpu.avg": { max: 3 },
    "t6_memory.rssMb": { max: 900 },
  },
};

const passingReport = {
  scenarios: {
    t1_plain: { mbps: 25.1, cpu: { avg: 80.2, max: 130 } },
    t2: { medianMs: 8.5, p95Ms: 14.2 },
    t5_idle: { cpu: { avg: 1.1, max: 4.0 } },
    t6_memory: { rssMb: 512 },
  },
};

test("통과 픽스처 → 위반 0", () => {
  const { violations } = checkBudgets(passingReport, budgets);
  assert.deepEqual(violations, []);
});

test("min 위반(처리량 하락)과 max 위반(레이턴시 상승)을 열거한다", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t1_plain.mbps = 3.2; // min 10 미달
  report.scenarios.t2.p95Ms = 95; // max 40 초과
  const { violations } = checkBudgets(report, budgets);
  assert.equal(violations.length, 2);
  const byPath = Object.fromEntries(violations.map((v) => [v.path, v]));
  assert.equal(byPath["t1_plain.mbps"].kind, "BELOW_MIN");
  assert.equal(byPath["t1_plain.mbps"].actual, 3.2);
  assert.equal(byPath["t1_plain.mbps"].limit, 10);
  assert.equal(byPath["t2.p95Ms"].kind, "ABOVE_MAX");
  assert.equal(byPath["t2.p95Ms"].actual, 95);
  assert.equal(byPath["t2.p95Ms"].limit, 40);
});

test("리포트에 예산 지표가 없으면 MISSING 위반 — 시나리오 무언 탈락 방지", () => {
  const report = structuredClone(passingReport);
  delete report.scenarios.t2; // t2 통째 누락
  delete report.scenarios.t5_idle.cpu; // 중간 경로 누락
  const { violations } = checkBudgets(report, budgets);
  const kinds = Object.fromEntries(violations.map((v) => [v.path, v.kind]));
  assert.equal(kinds["t2.medianMs"], "MISSING");
  assert.equal(kinds["t2.p95Ms"], "MISSING");
  assert.equal(kinds["t5_idle.cpu.avg"], "MISSING");
});

test("경계값은 통과(초과/미달만 위반)", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t1_plain.mbps = 10; // == min
  report.scenarios.t2.medianMs = 20; // == max
  const { violations } = checkBudgets(report, budgets);
  assert.deepEqual(violations, []);
});

test("숫자가 아닌 지표값은 MISSING 취급", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t2.medianMs = "n/a";
  const { violations } = checkBudgets(report, budgets);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "MISSING");
});
