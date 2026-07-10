// 기준선 축소 게이트(baseline-gate) — 코드 위생 위반 집합을 봉인하고 축소만 허용한다. R4(기준 약화 금지)의 기계화다.
//
// 기준선은 봉인이지 해소가 아니다. baseline-*.txt 에 실린 항목은 "고쳐진 것"이 아니라
// "지금 있는 부채를 더 늘리지 못하게 잠근 것"이다. 봉인 항목별 제거 조건:
//   - unwrap:      해당 파일의 `.unwrap(` 호출을 에러 전파(`?`)·명시 처리로 대체해 수를 줄인다.
//                  줄면 게이트가 stale 로 실패하고 `--prune` 이 그 수만큼 기준선을 내린다. 0이 되면 항목이 삭제된다.
//   - file-length: 파일을 상한(1500줄) 이하로 분할한다. 이하가 되면 stale → `--prune` 으로 항목이 삭제된다.
// 기준선을 올리는 유일한 길은 명시 재입법(baseline 파일 직접 수정+커밋 리뷰)뿐이다 — 무언 완화 금지(C5).
// 파일 개명 시 같은 커밋에서 항목 경로를 수기로 이전한다(값 불변 — 리뷰 diff 에 봉인 연속성이 남는다).
//
// 알고리즘: 전수 스캔 → 기준선 대조 →
//   신규(기준선에 없거나 봉인 값 초과)        = exit 1
//   stale(기준선에 있는데 실제론 줄었거나 소멸) = exit 1 — 축소 반영은 `--prune` 으로만 한다
//   `--init`  = 최초 1회 부트스트랩. 기준선 파일이 이미 있으면 거부한다(재봉인 우회 금지).
//   `--prune` = 축소만 반영한다(값을 올리거나 항목을 추가하지 않는다). 신규 위반은 prune 후에도 실패한다.
// SELF 제외: scripts/gates/ 아래(게이트 자신·기준선 데이터·짝 테스트)는 어느 지표에서도 스캔하지 않는다.
//
// 사용: node scripts/gates/baseline-gate.mjs [--init|--prune] [--root <dir>]
// 짝 테스트: scripts/gates/baseline-gate.test.mjs (vitest)

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── 지표 정의 ──────────────────────────────────────────────────────────────

// 파일 길이 상한. 실측 분포 근거(2026-07-11): 상한 초과 7파일이 1503~2729줄 구간에 있고
// 다음 최대가 1248줄 — 분포의 갭(1248↔1503)에 상한을 둔다. 임의 선긋기가 아니다.
const LENGTH_LIMIT = 1500;

const NEEDLE = ".unwrap(";

const METRICS = [
  {
    name: "unwrap",
    baselineFile: "baseline-unwrap.txt",
    roots: ["src-tauri/src", "src-tauri/cli/src"],
    exts: [".rs"],
    // 파일 전문 계수(인라인 #[cfg(test)] 모듈 포함 — 보수적 봉인, 숨는 방향의 오차가 없다).
    measure: (text) => text.split(NEEDLE).length - 1,
    unit: "건",
    fixHint: `\`${NEEDLE}\` 를 에러 전파(\`?\`)·명시 처리로 대체한 뒤 --prune 으로 축소를 반영한다`,
    headerLines: [
      `# baseline-unwrap — 파일별 \`${NEEDLE}\` 봉인 수. 이 파일은 봉인이지 해소가 아니다.`,
      "# 갱신은 --prune(축소)만. 값을 올리는 것은 명시 재입법 커밋으로만 한다(C5 — 무언 완화 금지).",
      `# 제거 조건: 해당 파일의 \`${NEEDLE}\` 를 에러 전파/명시 처리로 대체 → stale 실패 → --prune. 0이면 항목이 삭제된다.`,
      "# 파일 개명 시 같은 커밋에서 항목 경로를 수기로 이전한다(값 불변).",
    ],
  },
  {
    name: "file-length",
    baselineFile: "baseline-file-length.txt",
    roots: [
      "src",
      "src-tauri/src",
      "src-tauri/cli/src",
      "packages/plugin-api/src",
      "packages/plugin-spec/src",
      "scripts",
    ],
    exts: [".rs", ".ts", ".tsx", ".mjs"],
    // 상한 초과분만 위반값으로 본다(이하=0=무위반). wc -l 과 같은 줄 수 산식.
    measure: (text) => {
      const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      return lines > LENGTH_LIMIT ? lines : 0;
    },
    unit: "줄",
    fixHint: `파일을 ${LENGTH_LIMIT}줄 이하로 분할한 뒤 --prune 으로 축소를 반영한다`,
    headerLines: [
      `# baseline-file-length — ${LENGTH_LIMIT}줄 초과 파일의 봉인 줄 수. 이 파일은 봉인이지 해소가 아니다.`,
      "# 갱신은 --prune(축소)만. 값을 올리는 것은 명시 재입법 커밋으로만 한다(C5 — 무언 완화 금지).",
      `# 제거 조건: 파일을 ${LENGTH_LIMIT}줄 이하로 분할 → stale 실패 → --prune 으로 항목이 삭제된다.`,
      "# 파일 개명 시 같은 커밋에서 항목 경로를 수기로 이전한다(값 불변).",
    ],
  },
];

// ── 스캔 ──────────────────────────────────────────────────────────────────

// SELF 제외 — 게이트 자신·기준선 데이터·짝 테스트. 어느 지표에서도 스캔하지 않는다.
const SELF_PREFIX = "scripts/gates/";
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", "tests"]);
const TEST_FILE = /(\.test\.(ts|tsx|mjs)|_test\.rs)$/;

function walk(absDir, relDir, exts, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // 루트 부재는 위반이 아니다(픽스처 루트 등 부분 트리 허용).
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue; // 심링크 금지 원칙 — 추적하지 않는다.
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (`${rel}/`.startsWith(SELF_PREFIX)) continue;
      walk(join(absDir, e.name), rel, exts, out);
    } else if (e.isFile()) {
      if (rel.startsWith(SELF_PREFIX)) continue;
      if (TEST_FILE.test(e.name)) continue;
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      out.push(rel);
    }
  }
}

// 지표별 현행 위반 지도 {상대경로: 값>0} 를 만든다.
function scan(root, metric) {
  const files = [];
  for (const r of metric.roots) {
    walk(join(root, r), r.replaceAll("\\", "/"), metric.exts, files);
  }
  const current = new Map();
  for (const f of files.sort()) {
    const value = metric.measure(readFileSync(join(root, f), "utf8"));
    if (value > 0) current.set(f, value);
  }
  return current;
}

// ── 기준선 파일 입출력 ─────────────────────────────────────────────────────

function baselinePath(root, metric) {
  return join(root, "scripts/gates", metric.baselineFile);
}

function readBaseline(root, metric) {
  const p = baselinePath(root, metric);
  if (!existsSync(p)) return null;
  const map = new Map();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sp = t.lastIndexOf(" ");
    const file = t.slice(0, sp);
    const value = Number(t.slice(sp + 1));
    if (!file || !Number.isInteger(value) || value <= 0) {
      throw new Error(`기준선 형식 오류(${metric.baselineFile}): "${t}"`);
    }
    map.set(file, value);
  }
  return map;
}

function writeBaseline(root, metric, map) {
  const entries = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const body = entries.map(([f, v]) => `${f} ${v}`).join("\n");
  writeFileSync(baselinePath(root, metric), `${metric.headerLines.join("\n")}\n${body}${body ? "\n" : ""}`);
}

// ── 대조 ──────────────────────────────────────────────────────────────────

function diff(baseline, current) {
  const added = []; // 신규: 기준선에 없거나 봉인 값 초과.
  const stale = []; // stale: 기준선에 있는데 실제론 줄었거나 소멸.
  for (const [file, value] of current) {
    const sealed = baseline.get(file) ?? 0;
    if (value > sealed) added.push({ file, value, sealed });
  }
  for (const [file, sealed] of baseline) {
    const value = current.get(file) ?? 0;
    if (value < sealed) stale.push({ file, value, sealed });
  }
  return { added, stale };
}

// ── 실행 ──────────────────────────────────────────────────────────────────

function usage() {
  console.error("사용: node scripts/gates/baseline-gate.mjs [--init|--prune] [--root <dir>]");
}

function main(argv) {
  let init = false;
  let prune = false;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--init") init = true;
    else if (a === "--prune") prune = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (!v) return usage(), 1;
      root = resolve(v);
    } else return usage(), 1;
  }
  if (init && prune) {
    console.error("[baseline-gate] --init 과 --prune 은 함께 쓰지 못한다.");
    return 1;
  }

  // --init: 최초 1회 부트스트랩. 어느 기준선이라도 이미 있으면 전체를 거부한다(재봉인 우회 금지).
  if (init) {
    const existing = METRICS.filter((m) => existsSync(baselinePath(root, m)));
    if (existing.length > 0) {
      for (const m of existing) {
        console.error(
          `[baseline-gate] --init 거부: ${relative(root, baselinePath(root, m))} 이미 존재. 축소는 --prune, 값 올림은 명시 재입법 커밋으로만 한다.`,
        );
      }
      return 1;
    }
    for (const m of METRICS) {
      const current = scan(root, m);
      writeBaseline(root, m, current);
      console.log(`[baseline-gate] ${m.name}: ${current.size}개 파일 봉인 → ${relative(root, baselinePath(root, m))}`);
    }
    return 0;
  }

  let failed = false;
  for (const m of METRICS) {
    const baseline = readBaseline(root, m);
    if (baseline === null) {
      console.error(
        `[baseline-gate] 기준선 부재: ${relative(root, baselinePath(root, m))} — 최초 1회 --init 으로 부트스트랩한다.`,
      );
      failed = true;
      continue;
    }
    const current = scan(root, m);
    let { added, stale } = diff(baseline, current);

    if (prune && stale.length > 0) {
      // 축소만 반영: 값 내림 또는 항목 삭제. 값 올림·항목 추가는 절대 하지 않는다.
      for (const s of stale) {
        if (s.value > 0) baseline.set(s.file, s.value);
        else baseline.delete(s.file);
      }
      writeBaseline(root, m, baseline);
      for (const s of stale) {
        console.log(`[baseline-gate] ${m.name} prune: ${s.file} ${s.sealed}${m.unit} → ${s.value > 0 ? `${s.value}${m.unit}` : "항목 삭제"}`);
      }
      stale = [];
    }

    for (const a of added) {
      console.error(
        `[baseline-gate] 신규 위반 ${m.name}: ${a.file} — ${a.value}${m.unit} (봉인 ${a.sealed}${m.unit}). ${m.fixHint}. 늘림은 명시 재입법 커밋으로만 한다.`,
      );
      failed = true;
    }
    for (const s of stale) {
      console.error(
        `[baseline-gate] stale 봉인 ${m.name}: ${s.file} — 실측 ${s.value}${m.unit} < 봉인 ${s.sealed}${m.unit}. --prune 으로 축소를 반영한다(자동 축소는 하지 않는다).`,
      );
      failed = true;
    }
    if (added.length === 0 && stale.length === 0) {
      console.log(`[baseline-gate] ${m.name} OK — 봉인 ${baseline.size}개 파일, 신규 0, stale 0`);
    }
  }
  return failed ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
