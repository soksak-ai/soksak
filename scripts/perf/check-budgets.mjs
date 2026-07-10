#!/usr/bin/env node
// 예산 게이트 — 성능 리포트 JSON 을 budgets.json 과 대조해 위반을 전부 열거하고,
// 위반이 하나라도 있으면 exit 1. ptyd 등 터미널 데이터 경로 수술의 회귀 감지망(W4 M3).
//
// 사용: node check-budgets.mjs <report.json> [budgets.json(기본: 이 스크립트 옆)]
//
// budgets.json 형식:
//   { "meta": {...측정 조건 기록...},
//     "budgets": { "<시나리오>.<지표.경로>": { "min"?: n, "max"?: n } } }
// 경로는 report.scenarios 아래를 점 표기로 내려간다(예: "t1_plain.cpu.avg").
// 예산에 있는 지표가 리포트에 없으면 MISSING 위반 — 시나리오가 조용히 빠지는
// 무언 탈락(게이트 공동화)을 막는다.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function dig(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 순수 판정 — {violations:[{path, kind, actual, limit}]} (kind: BELOW_MIN|ABOVE_MAX|MISSING). */
export function checkBudgets(report, budgets) {
  const scenarios = report?.scenarios ?? {};
  const violations = [];
  for (const [p, limit] of Object.entries(budgets?.budgets ?? {})) {
    const actual = dig(scenarios, p);
    if (typeof actual !== "number" || Number.isNaN(actual)) {
      violations.push({ path: p, kind: "MISSING", actual: actual ?? null, limit });
      continue;
    }
    if (typeof limit.min === "number" && actual < limit.min) {
      violations.push({ path: p, kind: "BELOW_MIN", actual, limit: limit.min });
    }
    if (typeof limit.max === "number" && actual > limit.max) {
      violations.push({ path: p, kind: "ABOVE_MAX", actual, limit: limit.max });
    }
  }
  return { violations };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [reportPath, budgetsPath] = process.argv.slice(2);
  if (!reportPath) {
    console.error("사용법: check-budgets.mjs <report.json> [budgets.json]");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bPath = budgetsPath ?? path.join(here, "budgets.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const budgets = JSON.parse(fs.readFileSync(bPath, "utf8"));
  const { violations } = checkBudgets(report, budgets);
  if (violations.length === 0) {
    console.log(`perf-gate 통과 — ${Object.keys(budgets.budgets ?? {}).length}개 예산 전부 예산 내 (${path.basename(reportPath)})`);
    process.exit(0);
  }
  console.error(`perf-gate 실패 — 위반 ${violations.length}건 (${path.basename(reportPath)}):`);
  for (const v of violations) {
    const dir = v.kind === "BELOW_MIN" ? "<" : v.kind === "ABOVE_MAX" ? ">" : "누락";
    console.error(
      v.kind === "MISSING"
        ? `  · ${v.path}: 리포트에 없음(예산 ${JSON.stringify(v.limit)}) — 시나리오 무언 탈락 금지`
        : `  · ${v.path}: ${v.actual} ${dir} 예산 ${v.limit} (${v.kind})`,
    );
  }
  process.exit(1);
}
